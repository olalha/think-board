// Takes the README's screenshots (docs/images/) from a fresh think: the welcome
// canvas, scripted agent turns, an outside agent at work, History, comments and
// the phone layout. Nothing real is
// called: the agent is the test suite's scripted one (test/fixtures/fake-agent.mjs).
//
//   npm run screenshots        (builds the client first)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(app, "docs", "images");
const PORT = 3097;
const base = `http://127.0.0.1:${PORT}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "think-shots-"));

// What the scripted agent does when asked (see FAKE_SCENE in the fake agent).
const scene = [
  {
    match: "team offsite",
    files: {
      "offsite-ideas.md": [
        "# Offsite ideas",
        "",
        "- **Build day** — pair up and ship one small thing customers asked for",
        "- **Hike and plan** — a morning walk, then next quarter on a whiteboard",
        "- **Cook together** — a cooking class where each team runs one course",
        "",
        "Next: rank them in *Weigh your options*.",
        "",
      ].join("\n"),
    },
    run: [
      "think add offsite-ideas.md --near weigh-your-options --side below --size 460x280",
      'think link offsite-ideas weigh-your-options --label "rank them" --style dashed',
      'think summary "Added three offsite ideas"',
    ],
    reply:
      "Added **Offsite ideas** below *Weigh your options*: a build day, a hike with planning, and cooking together.\n\nWant me to put them into *Weigh your options* so you can rank them?",
  },
  {
    match: "Address the comments",
    files: {
      "weigh-your-options.html": fs
        .readFileSync(path.join(app, "examples", "welcome", "weigh-your-options.html"), "utf8")
        .replace('{ name: "Mobile app", value: 9, effort: 8 },', '{ name: "Mobile app", value: 9, effort: 8 },\n    { name: "Team podcast", value: 6, effort: 5 },'),
    },
    run: ['think comment done c-welcome-1 "Added a fourth option: a team podcast"', 'think summary "Added a podcast to Weigh your options"'],
    reply:
      "Added **Team podcast** to *Weigh your options* and marked the comment done.\n\nIt ranks third: worth doing, but slower to get going than the newsletter.",
  },
];
fs.mkdirSync(path.join(root, "config"), { recursive: true });
fs.writeFileSync(path.join(root, "scene.json"), JSON.stringify(scene));
fs.writeFileSync(path.join(root, "config", "think.json"), JSON.stringify({ git: { defaultAutosaveSeconds: 0 }, agent: { defaultProvider: "fake", idleShutdownSeconds: 30 } }));
fs.writeFileSync(
  path.join(root, "config", "providers.json"),
  JSON.stringify({
    fake: {
      label: "Claude Code",
      command: process.execPath,
      args: [path.join(app, "test", "fixtures", "fake-agent.mjs")],
      env: { FAKE_SCENE: path.join(root, "scene.json"), NODE_PATH: path.join(app, "node_modules") },
      auth: "login",
      instructionsFile: "AGENTS.md",
      instructionsTemplate: "project-agents.md",
    },
  }),
);

const server = spawn(process.execPath, ["--import", "tsx", path.join(app, "src", "server", "index.ts")], {
  cwd: app,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, THINK_ROOT: root, THINK_APP_DIR: app, THINK_PORT: String(PORT), THINK_HOST: "127.0.0.1" },
});
const think = (...args) => {
  const r = spawnSync("sh", [path.join(app, "bin", "think"), ...args], { env: { ...process.env, THINK_ROOT: root }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`think ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

async function main() {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
  const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });

  // 1. The welcome canvas, after a turn of the agent.
  await page.goto(`${base}/p/welcome-to-think`);
  await page.locator(".chat-head .pill.ok").waitFor({ timeout: 20_000 });
  const input = page.locator(".composer-input");
  await input.fill("Add three ideas for a team offsite, and somewhere to rank them");
  await input.press("Enter");
  await page.getByText("Want me to put them into").waitFor({ timeout: 20_000 });
  await page.locator(".lock-banner.show").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
  await page.mouse.click(700, 860); // an empty spot: nothing selected
  await page.keyboard.press("2"); // the view "Everything"
  await page.waitForTimeout(1500);
  await shot("canvas");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(1200);
  await shot("canvas-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // 2. An outside agent (any agent on the machine) working with the think command.
  think("join", "welcome-to-think", "--as", "planner", "--about", "Claude Code in a terminal");
  think("lock", "Planning the build day", "--as", "planner");
  const dir = path.join(root, "data", "welcome-to-think");
  fs.writeFileSync(
    path.join(dir, "build-day.mmd"),
    ["flowchart TD", "  pick[Pick one customer request] --> pair[Pair up]", "  pair --> ship[Ship by 4 pm]", "  ship --> demo([Demo over dinner])", ""].join("\n"),
  );
  await page.waitForTimeout(800);
  think("add", "build-day.mmd", "--near", "offsite-ideas", "--side", "right", "--size", "320x400", "--as", "planner");
  think("link", "offsite-ideas", "build-day", "--label", "plan", "--as", "planner");
  think("say", "Drafted a plan for the build day next to *Offsite ideas*. Shall I add who pairs with whom?", "--as", "planner");
  await page.getByRole("tab", { name: /planner/ }).click();
  await page.mouse.click(700, 860);
  await page.keyboard.press("f"); // fit everything
  await page.waitForTimeout(1500);
  await shot("outside-agent");
  think("unlock", "Planned the build day", "--as", "planner");

  // 3. History: every change, by whom, with a preview of the past.
  await page.getByRole("tab", { name: "Claude Code" }).click().catch(() => {});
  await page.getByLabel("Toggle side panel").click();
  await page.getByRole("tab", { name: "History" }).click();
  await page.waitForTimeout(1500);
  await shot("history");

  // 4. Comments: the agent works through them and ticks them off.
  await page.getByRole("tab", { name: "Comments" }).click();
  await input.fill("Address the comments");
  await input.press("Enter");
  await page.getByText("It ranks third").waitFor({ timeout: 20_000 });
  await page.locator(".lock-banner.show").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
  await page.getByRole("radio", { name: /^Done/ }).click();
  await page.locator('[data-id="weigh-your-options"] .block-name').click();
  await page.keyboard.press("z"); // zoom to the selection, then a step back
  await page.waitForTimeout(600);
  await page.getByLabel("Zoom out").click();
  await page.mouse.click(1000, 860); // nothing selected
  await page.waitForTimeout(1200);
  await shot("comments");

  // 5. A phone: the canvas, and the chat — side by side in one picture.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: "light" });
  const p = await phone.newPage();
  await p.goto(`${base}/p/welcome-to-think`);
  await p.waitForTimeout(2500);
  await p.keyboard.press("Control+k"); // quick jump to the Welcome block
  await p.keyboard.type("Welcome");
  await p.waitForTimeout(400);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(1500);
  const canvasShot = await p.screenshot();
  await p.getByRole("button", { name: "Toggle chat" }).tap();
  await p.waitForTimeout(1200);
  const chatShot = await p.screenshot();
  await phone.close();
  const frame = (png) => `<img src="data:image/png;base64,${png.toString("base64")}">`;
  await page.setViewportSize({ width: 960, height: 900 });
  await page.setContent(`<style>
    body { margin: 0; background: transparent; }
    .pair { display: flex; gap: 48px; padding: 24px 48px; width: max-content; }
    img { width: 390px; border-radius: 36px; box-shadow: 0 0 0 1px rgba(0,0,0,.12), 0 18px 40px rgba(0,0,0,.18); }
  </style><div class="pair">${frame(canvasShot)}${frame(chatShot)}</div>`);
  await page.locator(".pair").screenshot({ path: path.join(out, "phone.png"), omitBackground: true });

  await browser.close();
}

main()
  .then(() => console.log(`screenshots: written to ${path.relative(process.cwd(), out)}/`))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill("SIGTERM");
    setTimeout(() => fs.rmSync(root, { recursive: true, force: true }), 1000);
  });
