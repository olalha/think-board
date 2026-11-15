// `think ask`: the canvas's own agent asks the user questions and waits for
// the answer. The questions arrive as JSON (the command's stdin), show in the
// canvas chat as a question card, and the user's answer goes back to the
// command as plain lines:
//
//   <question> → <label>[, <label>][, Other: <text>]
//
// The command waits at most WAIT_MS per call, to stay under the agents' shell
// timeouts; then it is told to run `think ask --wait <id>`, which waits again
// for the same questions. Stopping the turn (or the turn ending, or the agent
// process ending) cancels whatever is still unanswered.

import type { AskAnswer, AskQuestion, ChatEntry } from "../shared/protocol.js";
import { OpError } from "./canvas-ops.js";

export type QuestionEntry = Extract<ChatEntry, { kind: "question" }>;

/** A reply for the `think` command; `pending`: not answered yet, ask again with --wait. */
export interface AskReply {
  ok: boolean;
  message: string;
  pending?: boolean;
}

export const ASK_WAIT_MS = 100_000;
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER = 12;
const MAX_QUESTION = 500;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 300;
const MAX_OTHER = 2000;

export const SKIPPED = "The user skipped these questions.";
export const CANCELLED = "The questions were cancelled: the turn was stopped or ended before the user answered.";

const EXAMPLE = `echo '{"questions":[{"question":"Which layout?","header":"Layout","options":[{"label":"Timeline"},{"label":"Mind map"}]}]}' | think ask`;

const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The questions from `think ask`'s JSON, checked; an OpError says what is wrong. */
export function parseAskSpec(text: string): AskQuestion[] {
  if (!text.trim()) throw new OpError(`think ask reads its questions as JSON on stdin, e.g.\n  ${EXAMPLE}\n(think help ask)`);
  let spec: unknown;
  try {
    spec = JSON.parse(text);
  } catch (err) {
    throw new OpError(`The questions are not valid JSON (${(err as Error).message}). Expected: {"questions":[…]} — think help ask.`);
  }
  const list = spec && typeof spec === "object" && !Array.isArray(spec) ? (spec as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(list)) throw new OpError(`Expected {"questions":[…]}: an object with a "questions" list (think help ask).`);
  if (list.length < 1 || list.length > MAX_QUESTIONS) throw new OpError(`Ask 1 to ${MAX_QUESTIONS} questions at a time (got ${list.length}).`);
  const seen = new Set<string>();
  return list.map((raw, qi): AskQuestion => {
    const at = `Question ${qi + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new OpError(`${at}: expected an object with "question" and "options".`);
    const q = raw as Record<string, unknown>;
    if (!isText(q.question, MAX_QUESTION)) throw new OpError(`${at}: "question" must be text (at most ${MAX_QUESTION} characters).`);
    const question = q.question.trim();
    if (seen.has(question)) throw new OpError(`${at}: the same question is asked twice.`);
    seen.add(question);
    let header: string | undefined;
    if (q.header !== undefined && q.header !== "") {
      if (typeof q.header !== "string") throw new OpError(`${at}: "header" must be text.`);
      header = q.header.trim();
      if (header.length > MAX_HEADER) throw new OpError(`${at}: "header" is a short chip of at most ${MAX_HEADER} characters ("${header}" has ${header.length}).`);
    }
    if (q.multiSelect !== undefined && typeof q.multiSelect !== "boolean") throw new OpError(`${at}: "multiSelect" must be true or false.`);
    const opts = q.options;
    if (!Array.isArray(opts) || opts.length < MIN_OPTIONS || opts.length > MAX_OPTIONS) {
      throw new OpError(`${at}: give ${MIN_OPTIONS} to ${MAX_OPTIONS} "options" (got ${Array.isArray(opts) ? opts.length : "none"}). Don't list "Other": the app always offers it.`);
    }
    const labels = new Set<string>();
    const options = opts.map((rawOpt, oi) => {
      const where = `${at}, option ${oi + 1}`;
      if (!rawOpt || typeof rawOpt !== "object" || Array.isArray(rawOpt)) throw new OpError(`${where}: expected an object with a "label".`);
      const o = rawOpt as Record<string, unknown>;
      if (!isText(o.label, MAX_LABEL)) throw new OpError(`${where}: "label" must be text (at most ${MAX_LABEL} characters).`);
      const label = oneLine(o.label);
      if (/^other$/i.test(label)) throw new OpError(`${where}: don't list "Other" — the app always offers it, with a text field.`);
      if (labels.has(label.toLowerCase())) throw new OpError(`${where}: the label "${label}" is used twice.`);
      labels.add(label.toLowerCase());
      if (o.description !== undefined && o.description !== "" && !isText(o.description, MAX_DESCRIPTION)) {
        throw new OpError(`${where}: "description" must be text (at most ${MAX_DESCRIPTION} characters).`);
      }
      const description = typeof o.description === "string" && o.description.trim() ? o.description.trim() : undefined;
      return description ? { label, description } : { label };
    });
    return { question, ...(header ? { header } : {}), options, ...(q.multiSelect ? { multiSelect: true } : {}) };
  });
}

/** The user's answers (from the browser), checked against the questions; throws with what is wrong. */
export function checkAnswers(questions: AskQuestion[], raw: unknown): AskAnswer[] {
  if (!Array.isArray(raw) || raw.length !== questions.length) throw new Error("Answer every question (or Skip).");
  return questions.map((q, i) => {
    const a = raw[i] as { selected?: unknown; other?: unknown } | null;
    if (!a || typeof a !== "object") throw new Error("Answer every question (or Skip).");
    const selected = Array.isArray(a.selected) ? a.selected : [];
    if (!selected.every((s): s is string => typeof s === "string" && q.options.some((o) => o.label === s))) throw new Error("That answer is not one of the options.");
    const picked = [...new Set(selected)];
    const other = typeof a.other === "string" ? a.other.trim() : "";
    if (other.length > MAX_OTHER) throw new Error(`An "Other" answer is at most ${MAX_OTHER} characters.`);
    const count = picked.length + (other ? 1 : 0);
    if (count === 0) throw new Error("Answer every question (or Skip).");
    if (!q.multiSelect && count > 1) throw new Error(`“${q.question}” takes one answer.`);
    // In the options' order, whatever order they were clicked in.
    const ordered = q.options.map((o) => o.label).filter((l) => picked.includes(l));
    return other ? { selected: ordered, other } : { selected: ordered };
  });
}

/** The answers as the agent reads them: one line per question. */
export function formatAnswers(questions: AskQuestion[], answers: AskAnswer[]): string {
  return questions
    .map((q, i) => {
      const a = answers[i] ?? { selected: [] };
      const parts = [...a.selected, ...(a.other ? [`Other: ${oneLine(a.other)}`] : [])];
      return `${oneLine(q.question)} → ${parts.join(", ")}`;
    })
    .join("\n");
}

/** What the command is told about settled questions. */
export function settledReply(entry: QuestionEntry): AskReply {
  if (entry.outcome === "answered") return { ok: true, message: formatAnswers(entry.questions, entry.answers ?? []) };
  if (entry.outcome === "skipped") return { ok: true, message: SKIPPED };
  return { ok: false, message: CANCELLED };
}

/**
 * The questions waiting for the user, and the `think ask` calls waiting for
 * them (each with its own WAIT_MS timer). Settling one writes its chat entry
 * (`settle`) and answers every waiting call.
 */
export class QuestionDesk {
  private readonly pending = new Map<string, { entry: QuestionEntry; waiters: Set<(r: AskReply) => void> }>();

  constructor(
    private readonly waitMs: number,
    private readonly settle: (entry: QuestionEntry) => Promise<void>,
  ) {}

  get count(): number {
    return this.pending.size;
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  open(entry: QuestionEntry): void {
    this.pending.set(entry.id, { entry, waiters: new Set() });
  }

  /** Wait for the answer, at most waitMs; `settled` finds questions no longer pending (answered earlier). */
  wait(id: string, settled: (id: string) => QuestionEntry | undefined): Promise<AskReply> {
    const p = this.pending.get(id);
    if (!p) {
      const done = settled(id);
      if (done?.outcome) return Promise.resolve(settledReply(done));
      return Promise.resolve({ ok: false, message: `No questions "${id}" are waiting for an answer.` });
    }
    return new Promise((resolve) => {
      const done = (r: AskReply) => {
        clearTimeout(timer);
        p.waiters.delete(done);
        resolve(r);
      };
      const timer = setTimeout(() => done({ ok: true, pending: true, message: `Still waiting for the user's answer. Run: think ask --wait ${id}` }), this.waitMs);
      p.waiters.add(done);
    });
  }

  /** Settle questions: answered (`answers`), skipped (null) or cancelled. */
  async resolve(id: string, outcome: "answered" | "skipped" | "cancelled", answers?: AskAnswer[]): Promise<void> {
    const p = this.pending.get(id);
    if (!p) throw new Error("Those questions are no longer waiting for an answer.");
    this.pending.delete(id);
    const entry: QuestionEntry = { ...p.entry, outcome, ...(answers ? { answers } : {}) };
    await this.settle(entry).catch(() => {});
    const reply = settledReply(entry);
    for (const w of [...p.waiters]) w(reply);
  }

  /** Cancel everything still waiting (the turn was stopped or ended, the agent stopped). */
  cancelAll(): Promise<void> {
    return Promise.all([...this.pending.keys()].map((id) => this.resolve(id, "cancelled"))).then(() => undefined);
  }
}
