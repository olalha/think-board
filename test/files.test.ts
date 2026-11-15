// The files/ folder: path safety, the HTTP routes, the lock, live updates,
// commits, and post-turn validation leaving it alone.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { git } from "../src/server/git.js";
import type { ProjectManager } from "../src/server/manager.js";
import { cleanFilePath, freeFilePath, listReferenceFiles, MAX_REFERENCE_FILE_BYTES, resolveFilePath } from "../src/server/reference-files.js";
import type { ChatEntry, ServerMessage } from "../src/shared/protocol.js";
import { makeHarness, waitFor, type Harness } from "./helpers.js";

let h: Harness | null = null;
let app: FastifyInstance | null = null;
let tmp: string | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  await h?.close();
  h = null;
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = null;
});

/** The real app, with the harness's runtime as the only open canvas. */
async function serve(harness: Harness): Promise<{ app: FastifyInstance; base: string }> {
  const slug = harness.runtime.slug;
  const manager = {
    peek: (s: string) => (s === slug ? harness.runtime : undefined),
    get: async () => harness.runtime,
    openSlugs: () => [slug],
  } as unknown as ProjectManager;
  app = await buildApp({ paths: harness.paths, config: harness.config, store: harness.store, manager, version: "test", serveClient: false });
  return { app, base: `/api/projects/${slug}/reference-files` };
}

const put = (a: FastifyInstance, url: string, body: string | Buffer) =>
  a.inject({ method: "PUT", url, payload: Buffer.from(body), headers: { "content-type": "application/octet-stream" } });

const chat = (h: Harness): ChatEntry[] => {
  const byId = new Map<string, ChatEntry>();
  for (const m of h.messages as ServerMessage[]) if (m.type === "chat.append" || m.type === "chat.update") byId.set(m.entry.id, m.entry);
  return [...byId.values()];
};

describe("file paths", () => {
  it("accepts plain relative paths and refuses anything that could leave files/", () => {
    expect(cleanFilePath("data/sales 2024.csv")).toBe("data/sales 2024.csv");
    expect(cleanFilePath("notes/")).toBe("notes");
    for (const bad of ["", "  ", "..", "../x", "a/../../x", "a/./b", "/etc/passwd", "a//b", "a\\..\\b", ".env", "data/.hidden", "a\0b", "a\nb", 42, null]) {
      expect(() => cleanFilePath(bad), String(bad)).toThrow();
    }
    expect(() => cleanFilePath("a/".repeat(12) + "x")).toThrow(/nested/);
  });

  it("refuses symlinks anywhere on the way, and files/ itself being one", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "think-files-"));
    const canvas = path.join(tmp, "canvas");
    const outside = path.join(tmp, "outside");
    await fs.mkdir(path.join(canvas, "files", "real"), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "no");
    await fs.writeFile(path.join(canvas, "files", "real", "a.txt"), "yes");
    await fs.symlink(outside, path.join(canvas, "files", "out"));
    await fs.symlink(path.join(outside, "secret.txt"), path.join(canvas, "files", "secret.txt"));

    await expect(resolveFilePath(canvas, "real/a.txt")).resolves.toMatchObject({ kind: "file" });
    await expect(resolveFilePath(canvas, "real/new.txt")).resolves.toMatchObject({ kind: "missing" });
    await expect(resolveFilePath(canvas, "real/a.txt/below")).rejects.toThrow(/not a folder/);
    await expect(resolveFilePath(canvas, "out/secret.txt")).rejects.toThrow(/link/);
    await expect(resolveFilePath(canvas, "out/new.txt")).rejects.toThrow(/link/);
    await expect(resolveFilePath(canvas, "secret.txt")).rejects.toThrow(/link/);
    // The listing skips links and hidden files.
    await fs.writeFile(path.join(canvas, "files", ".DS_Store"), "");
    expect((await listReferenceFiles(canvas)).map((f) => f.path)).toEqual(["real/a.txt"]);
    expect(await freeFilePath(canvas, "real/a.txt")).toBe("real/a (2).txt");

    const linked = path.join(tmp, "linked");
    await fs.mkdir(linked);
    await fs.symlink(outside, path.join(linked, "files"));
    await expect(resolveFilePath(linked, "secret.txt")).rejects.toThrow(/link/);
    expect(await listReferenceFiles(linked)).toEqual([]);
  });
});

describe("the files/ folder", () => {
  it("uploads, lists, downloads, renames, moves and deletes over HTTP — and commits it", async () => {
    h = await makeHarness();
    const { app, base } = await serve(h);
    expect((await fs.stat(path.join(h.dir, "files"))).isDirectory()).toBe(true);

    let r = await put(app, `${base}/sales.csv`, "region,total\nnorth,3\n");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ path: "sales.csv" });
    expect(await fs.readFile(path.join(h.dir, "files", "sales.csv"), "utf8")).toBe("region,total\nnorth,3\n");
    expect(h.messages.some((m) => m.type === "files.changed" && m.files.some((f) => f.path === "sales.csv"))).toBe(true);

    // A taken name gets a new one; ?replace=1 overwrites.
    r = await put(app, `${base}/sales.csv`, "second");
    expect(r.json()).toEqual({ path: "sales (2).csv" });
    r = await put(app, `${base}/sales.csv?replace=1`, "region,total\nsouth,4\n");
    expect(r.json()).toEqual({ path: "sales.csv" });
    // Names with spaces and other characters, in a subfolder.
    r = await put(app, `${base}/raw%20data/r%C3%A9sum%C3%A9.txt`, "hi");
    expect(r.json()).toEqual({ path: "raw data/résumé.txt" });

    r = await app.inject({ url: base });
    expect(r.json().files.map((f: { path: string }) => f.path)).toEqual(["raw data/résumé.txt", "sales (2).csv", "sales.csv"]);
    expect(r.json().files[2]).toMatchObject({ size: 21 });

    r = await app.inject({ url: `${base}/sales.csv?download` });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="sales.csv"/);
    expect(r.headers["content-security-policy"]).toBe("sandbox");
    expect(r.body).toBe("region,total\nsouth,4\n");
    r = await app.inject({ url: `${base}/sales.csv` });
    expect(r.headers["content-type"]).toMatch(/^text\/plain/);
    expect(r.headers["content-disposition"]).toMatch(/^inline/);
    r = await app.inject({ url: `${base}/raw%20data/r%C3%A9sum%C3%A9.txt?download` });
    expect(r.headers["content-disposition"]).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.txt");
    // Something a browser could run is never served inline.
    await put(app, `${base}/page.html`, "<script>alert(1)</script>");
    r = await app.inject({ url: `${base}/page.html` });
    expect(r.headers["content-type"]).toBe("application/octet-stream");
    expect(r.headers["content-disposition"]).toMatch(/^attachment/);
    expect((await app.inject({ url: `${base}/nope.csv` })).statusCode).toBe(404);

    // Rename, then move into a folder; never over another file.
    r = await app.inject({ method: "PATCH", url: `${base}/sales%20(2).csv`, payload: { to: "old-sales.csv" } });
    expect(r.json()).toEqual({ path: "old-sales.csv" });
    r = await app.inject({ method: "PATCH", url: `${base}/old-sales.csv`, payload: { to: "archive/2023/sales.csv" } });
    expect(r.json()).toEqual({ path: "archive/2023/sales.csv" });
    r = await app.inject({ method: "PATCH", url: `${base}/archive/2023/sales.csv`, payload: { to: "sales.csv" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/already/);
    r = await app.inject({ method: "PATCH", url: `${base}/sales.csv`, payload: { to: "../escaped.csv" } });
    expect(r.statusCode).toBe(400);

    // Delete; the emptied folders go too.
    r = await app.inject({ method: "DELETE", url: `${base}/archive/2023/sales.csv` });
    expect(r.statusCode).toBe(200);
    expect(await fs.readdir(path.join(h.dir, "files"))).not.toContain("archive");
    expect((await app.inject({ method: "DELETE", url: `${base}/archive/2023/sales.csv` })).statusCode).toBe(400);

    // Versioned like the rest of the canvas.
    await h.runtime.handle(h.client, { type: "canvas.save" });
    const tracked = (await git(h.dir, ["ls-files", "-z", "files"])).split("\0").filter(Boolean);
    expect(tracked.sort()).toEqual(["files/page.html", "files/raw data/résumé.txt", "files/sales.csv"]);
    expect(await git(h.dir, ["log", "-1", "--format=%an|%s"])).toMatch(/^user\|user: .*files\/sales\.csv/);
  });

  it("refuses paths that leave the folder", async () => {
    h = await makeHarness();
    const { app, base } = await serve(h);
    for (const url of [`${base}/..%2F..%2Fescape.txt`, `${base}/%2e%2e/escape.txt`, `${base}/a/%2e%2e/%2e%2e/escape.txt`, `${base}/%2Fetc%2Fpasswd`, `${base}/.git/config`]) {
      const r = await put(app, url, "x");
      expect(r.statusCode, url).toBeGreaterThanOrEqual(400);
      const g = await app.inject({ url });
      expect(g.statusCode, url).toBeGreaterThanOrEqual(400);
    }
    expect(await fs.readdir(path.dirname(h.dir))).not.toContain("escape.txt");
    expect(await fs.readdir(h.dir)).not.toContain("escape.txt");
    // The canvas's own files are not reachable through this route either.
    expect((await app.inject({ url: `${base}/..%2Fcanvas.json` })).statusCode).toBe(400);
  });

  it("refuses changes while the agent works, and caps the size", async () => {
    h = await makeHarness();
    const { app, base } = await serve(h);
    await put(app, `${base}/keep.txt`, "keep");
    await h.runtime.handle(h.client, { type: "agent.prompt", text: "slow" });
    expect(h.runtime.working).toBe(true);
    const r = await put(app, `${base}/during.txt`, "x");
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/agent is working/);
    await expect(h.runtime.moveReferenceFile("keep.txt", "moved.txt")).rejects.toThrow(/agent is working/);
    await expect(h.runtime.deleteReferenceFile("keep.txt")).rejects.toThrow(/agent is working/);
    await h.waitIdle();
    expect(await fs.readdir(path.join(h.dir, "files"))).toEqual(["keep.txt"]);
    await expect(h.runtime.putReferenceFile("big.bin", Buffer.alloc(MAX_REFERENCE_FILE_BYTES + 1))).rejects.toThrow(/up to 50 MB/);
  });

  it("tells open tabs when something else changes the folder", async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.dir, "files", "exports"), { recursive: true });
    await fs.writeFile(path.join(h.dir, "files", "exports", "table.csv"), "a,b\n");
    await waitFor(() => h!.messages.some((m) => m.type === "files.changed" && m.files.some((f) => f.path === "exports/table.csv")), "the new file to be broadcast");
    await fs.rm(path.join(h.dir, "files", "exports"), { recursive: true });
    await waitFor(() => {
      const last = h!.messages.filter((m) => m.type === "files.changed").at(-1);
      return last?.type === "files.changed" && last.files.length === 0;
    }, "the removal to be broadcast");
  });

  it("is part of the canvas: an agent's files there are committed and not flagged", async () => {
    h = await makeHarness({ maxAttempts: 0 });
    await h.runtime.handle(h.client, { type: "agent.prompt", text: "export\nrun: mkdir -p files/exports && printf 'a,b\\n1,2\\n' > files/exports/table.csv" });
    await h.waitIdle();
    expect((await h.runs())[0]).toMatchObject({ code: 0 });
    expect(chat(h).some((e) => e.kind === "system" && /did not validate/.test(e.text))).toBe(false);
    const report = h.messages.filter((m) => m.type === "validation.errors").at(-1);
    expect(report?.type === "validation.errors" && report.report.issues).toEqual([]);
    expect((await git(h.dir, ["ls-files", "files"])).trim()).toBe("files/exports/table.csv");
    const body = await git(h.dir, ["log", "-1", "--format=%an|%B"]);
    expect(body).toMatch(/^agent\|/);
    expect(body).toContain("- Changed in files/: exports/table.csv");
    // The snapshot a new tab gets lists it.
    const seen: ServerMessage[] = [];
    h.runtime.attach({ id: "late", send: (m) => seen.push(m) });
    const snap = seen.find((m) => m.type === "project.snapshot");
    expect(snap?.type === "project.snapshot" && snap.files?.map((f) => f.path)).toEqual(["exports/table.csv"]);
    h.runtime.detach("late");
  });
});
