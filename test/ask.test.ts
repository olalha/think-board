// `think ask`: the canvas agent's questions to the user, from the JSON spec to
// the answer lines its command prints.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAnswers, formatAnswers, parseAskSpec, QuestionDesk, type QuestionEntry } from "../src/server/ask.js";
import type { AskQuestion, ChatEntry, ServerMessage } from "../src/shared/protocol.js";
import { APP_DIR, makeHarness, waitFor, type Harness } from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const send = (h: Harness, msg: Parameters<Harness["runtime"]["handle"]>[1]) => h.runtime.handle(h.client, msg);
const questionEntry = (h: Harness): QuestionEntry | undefined => {
  let found: QuestionEntry | undefined;
  for (const m of h.messages as ServerMessage[]) {
    if ((m.type === "chat.append" || m.type === "chat.update") && m.entry.kind === "question") found = m.entry;
  }
  return found;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPEC = {
  questions: [
    { question: "Which layout?", header: "Layout", options: [{ label: "Timeline", description: "one row per month" }, { label: "Mind map" }] },
    { question: "Which sections?", options: [{ label: "Goals" }, { label: "Risks" }, { label: "Budget" }], multiSelect: true },
  ],
};
/** A `run:` line for the fake agent: pipe a spec into think ask, then print its exit code. */
const askLine = (spec: unknown) => `run: printf '%s' '${JSON.stringify(spec)}' | think ask; echo "exit=$?"`;

describe("the questions (parseAskSpec)", () => {
  const spec = (questions: unknown) => JSON.stringify({ questions });
  const q = (extra: Record<string, unknown> = {}) => ({ question: "Which?", options: [{ label: "A" }, { label: "B" }], ...extra });

  it("accepts a valid spec and tidies it", () => {
    const parsed = parseAskSpec(JSON.stringify(SPEC));
    expect(parsed).toEqual<AskQuestion[]>([
      { question: "Which layout?", header: "Layout", options: [{ label: "Timeline", description: "one row per month" }, { label: "Mind map" }] },
      { question: "Which sections?", options: [{ label: "Goals" }, { label: "Risks" }, { label: "Budget" }], multiSelect: true },
    ]);
  });

  it("says clearly what is wrong", () => {
    expect(() => parseAskSpec("")).toThrow(/JSON on stdin/);
    expect(() => parseAskSpec("{nope")).toThrow(/not valid JSON/);
    expect(() => parseAskSpec("[]")).toThrow(/"questions"/);
    expect(() => parseAskSpec(spec([]))).toThrow(/1 to 4 questions/);
    expect(() => parseAskSpec(spec([q({ question: "1" }), q({ question: "2" }), q({ question: "3" }), q({ question: "4" }), q({ question: "5" })]))).toThrow(/1 to 4 questions at a time \(got 5\)/);
    expect(() => parseAskSpec(spec([q({ question: "" })]))).toThrow(/Question 1: "question"/);
    expect(() => parseAskSpec(spec([q(), q()]))).toThrow(/asked twice/);
    expect(() => parseAskSpec(spec([q({ header: "Much too long here" })]))).toThrow(/at most 12 characters/);
    expect(() => parseAskSpec(spec([q({ options: [{ label: "A" }] })]))).toThrow(/2 to 4 "options" \(got 1\)/);
    expect(() => parseAskSpec(spec([q({ options: [1, 2, 3, 4, 5].map((n) => ({ label: `L${n}` })) })]))).toThrow(/got 5/);
    expect(() => parseAskSpec(spec([q({ options: [{ label: "A" }, { label: "Other" }] })]))).toThrow(/don't list "Other"/);
    expect(() => parseAskSpec(spec([q({ options: [{ label: "A" }, { label: "a" }] })]))).toThrow(/used twice/);
    expect(() => parseAskSpec(spec([q({ options: [{ label: "A" }, { name: "B" }] })]))).toThrow(/Question 1, option 2: "label"/);
    expect(() => parseAskSpec(spec([q({ multiSelect: "yes" })]))).toThrow(/"multiSelect" must be true or false/);
  });
});

describe("the answers (checkAnswers, formatAnswers)", () => {
  const qs = parseAskSpec(JSON.stringify(SPEC));

  it("checks them against the questions", () => {
    expect(checkAnswers(qs, [{ selected: ["Timeline"] }, { selected: ["Risks", "Goals"], other: "  a budget  " }])).toEqual([
      { selected: ["Timeline"] },
      { selected: ["Goals", "Risks"], other: "a budget" },
    ]);
    expect(() => checkAnswers(qs, [{ selected: ["Timeline"] }])).toThrow(/every question/);
    expect(() => checkAnswers(qs, [{ selected: ["Timeline"] }, { selected: [] }])).toThrow(/every question/);
    expect(() => checkAnswers(qs, [{ selected: ["Gantt"] }, { selected: ["Goals"] }])).toThrow(/not one of the options/);
    expect(() => checkAnswers(qs, [{ selected: ["Timeline", "Mind map"] }, { selected: ["Goals"] }])).toThrow(/takes one answer/);
    expect(() => checkAnswers(qs, [{ selected: ["Timeline"], other: "both" }, { selected: ["Goals"] }])).toThrow(/takes one answer/);
  });

  it("prints one plain line per question", () => {
    expect(formatAnswers(qs, [{ selected: [], other: "a\nGantt chart" }, { selected: ["Goals", "Risks"], other: "a budget" }])).toBe(
      "Which layout? → Other: a Gantt chart\nWhich sections? → Goals, Risks, Other: a budget",
    );
  });
});

describe("waiting (QuestionDesk)", () => {
  it("says 'still waiting' after its wait, then hands over an answer given meanwhile", async () => {
    const settled = new Map<string, QuestionEntry>();
    const desk = new QuestionDesk(50, async (e) => void settled.set(e.id, e));
    const entry: QuestionEntry = { kind: "question", id: "q-1", ts: 0, questions: parseAskSpec(JSON.stringify(SPEC)) };
    desk.open(entry);
    expect(await desk.wait("q-1", (id) => settled.get(id))).toEqual({ ok: true, pending: true, message: "Still waiting for the user's answer. Run: think ask --wait q-1" });
    await desk.resolve("q-1", "answered", [{ selected: ["Mind map"] }, { selected: ["Budget"] }]);
    expect(await desk.wait("q-1", (id) => settled.get(id))).toEqual({ ok: true, message: "Which layout? → Mind map\nWhich sections? → Budget" });
    expect((await desk.wait("q-2", () => undefined)).ok).toBe(false);
  });

  it("answers every waiting call when cancelled", async () => {
    const desk = new QuestionDesk(10_000, async () => {});
    desk.open({ kind: "question", id: "q-1", ts: 0, questions: parseAskSpec(JSON.stringify(SPEC)) });
    const a = desk.wait("q-1", () => undefined);
    const b = desk.wait("q-1", () => undefined);
    await desk.cancelAll();
    expect((await a).ok).toBe(false);
    expect((await b).message).toMatch(/cancelled/);
    expect(desk.count).toBe(0);
  });
});

describe("think ask in a turn", () => {
  it("shows a question card, waits, and prints the user's answers", async () => {
    h = await makeHarness();
    await send(h, { type: "agent.prompt", text: askLine(SPEC) });
    await waitFor(() => !!questionEntry(h!), "the question card");
    const q = questionEntry(h)!;
    expect(q.questions[0]).toMatchObject({ question: "Which layout?", header: "Layout" });
    expect(q.outcome).toBeUndefined();
    await expect(send(h, { type: "agent.answer", questionId: q.id, answers: [{ selected: ["Nope"] }, { selected: ["Goals"] }] })).rejects.toThrow(/not one of the options/);
    await send(h, { type: "agent.answer", questionId: q.id, answers: [{ selected: ["Timeline"] }, { selected: ["Goals", "Risks"], other: "a budget" }] });
    await h.waitIdle();
    const [run] = await h.runs();
    expect(run.out).toBe("Which layout? → Timeline\nWhich sections? → Goals, Risks, Other: a budget\nexit=0\n");
    expect(questionEntry(h)).toMatchObject({ outcome: "answered", answers: [{ selected: ["Timeline"] }, { selected: ["Goals", "Risks"], other: "a budget" }] });
    // Kept in the chat log like any entry.
    const stored = (await fs.readFile(path.join(h.dir, ".think", "chat.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as ChatEntry)
      .filter((e) => e.id === q.id);
    expect(stored.at(-1)).toMatchObject({ kind: "question", outcome: "answered" });
    // Answered once: a second answer is refused.
    await expect(send(h, { type: "agent.answer", questionId: q.id, answers: null })).rejects.toThrow(/no longer waiting/);
  });

  it("tells the agent when the user skips", async () => {
    h = await makeHarness();
    await send(h, { type: "agent.prompt", text: askLine(SPEC) });
    await waitFor(() => !!questionEntry(h!), "the question card");
    await send(h, { type: "agent.answer", questionId: questionEntry(h)!.id, answers: null });
    await h.waitIdle();
    expect((await h.runs())[0].out).toBe("The user skipped these questions.\nexit=0\n");
    expect(questionEntry(h)?.outcome).toBe("skipped");
  });

  it("refuses an invalid spec without showing anything", async () => {
    h = await makeHarness();
    await send(h, { type: "agent.prompt", text: askLine({ questions: [{ question: "Which?", options: [{ label: "A" }, { label: "Other" }] }] }) });
    await h.waitIdle();
    const [run] = await h.runs();
    expect(run.out).toBe("exit=1\n");
    expect(run.err).toMatch(/don't list "Other"/);
    expect(questionEntry(h)).toBeUndefined();
  });

  it("says 'still waiting' (exit 3) after its wait; think ask --wait picks the same questions up", async () => {
    h = await makeHarness({ askWaitMs: 1500 });
    await send(h, {
      type: "agent.prompt",
      text: `run: out=$(printf '%s' '${JSON.stringify(SPEC)}' | think ask); echo "first=$? $out"; think ask --wait "\${out##* }"; echo "second=$?"`,
    });
    await waitFor(() => !!questionEntry(h!), "the question card");
    const q = questionEntry(h)!;
    await sleep(2000); // past the first wait, inside the second
    await send(h, { type: "agent.answer", questionId: q.id, answers: [{ selected: ["Mind map"] }, { selected: ["Budget"] }] });
    await h.waitIdle();
    const [run] = await h.runs();
    expect(run.out).toBe(`first=3 Still waiting for the user's answer. Run: think ask --wait ${q.id}\nWhich layout? → Mind map\nWhich sections? → Budget\nsecond=0\n`);
  });

  it("cancels the questions when the user stops the turn", async () => {
    h = await makeHarness();
    await send(h, { type: "agent.prompt", text: askLine(SPEC) });
    await waitFor(() => !!questionEntry(h!), "the question card");
    const q = questionEntry(h)!;
    await send(h, { type: "agent.cancel" });
    await h.waitIdle();
    const [run] = await h.runs();
    expect(run.out).toBe("exit=1\n");
    expect(run.err).toMatch(/cancelled/);
    expect(questionEntry(h)?.outcome).toBe("cancelled");
    await expect(send(h, { type: "agent.answer", questionId: q.id, answers: null })).rejects.toThrow(/no longer waiting/);
  });

  it("is refused to outside agents", async () => {
    h = await makeHarness();
    const r = spawnSync("/bin/sh", [path.join(APP_DIR, "bin", "think"), "ask", "--as", "planner"], {
      input: JSON.stringify(SPEC),
      env: { PATH: process.env.PATH ?? "", HOME: h.root, THINK_ROOT: h.root },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/only for a canvas's own agent/);
  });
});
