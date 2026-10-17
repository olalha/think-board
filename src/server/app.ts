// HTTP + WebSocket server.
//
//   GET  /api/health                       liveness (used by the container healthcheck)
//   GET  /api/info                         version, config summary, providers
//   GET  /api/projects                     project list
//   POST /api/projects                     create {name, provider}
//   PATCH /api/projects/:slug              rename {name}
//   GET  /api/projects/:slug/files/:file   raw block file (images; downloads); ?rev=<commit> for History
//   POST /api/projects/:slug/images        upload an image (raw body) → new block, or ?replace=<name>
//   GET  /api/projects/:slug/drawings/:name/base   a drawing's original image (?file=base-….png: that one)
//   POST /api/projects/:slug/drawings/:name/base   a photo to become a drawing's page (raw body) → {file, width, height}
//   POST /api/projects/:slug/beacon        last-gasp autosave from a closing tab (sendBeacon)
//   GET  /ws/projects/:slug                the project's WebSocket (see shared/protocol.ts)
//   GET  /render/:slug/:block              reserved render-only route (client-side)
//
// Everything else serves the built client, falling back to index.html.

import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { EXTENSION_PRECEDENCE, IMAGE_MIME, parseBlockFile } from "../shared/blocks.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import type { ConfigStore, Paths } from "./config.js";
import { providerHome } from "./agent/env.js";
import { providerUsage } from "./agent/usage.js";
import { agentPlacement } from "./agent/process.js";
import { Auth, loginPage } from "./auth.js";
import { showFile } from "./git.js";
import type { ProjectManager } from "./manager.js";
import { SLUG_RE, UserError, type ProjectStore } from "./projects.js";
import { NewerFormatError } from "./think-file.js";
import { BASE_FILE_RE, readDrawing, sidecarDir } from "./drawings.js";
import type { ClientConn, ProjectRuntime } from "./runtime.js";
import { errorMessage, newId } from "./util.js";

export interface AppDeps {
  paths: Paths;
  config: ConfigStore;
  store: ProjectStore;
  manager: ProjectManager;
  version: string;
  /** Serve the built client from paths.clientDir (production). */
  serveClient: boolean;
}

const PING_MS = 25_000; // Cloudflare closes WebSockets idle for ~100s

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { paths, config, store, manager } = deps;
  const app = Fastify({
    logger: { level: process.env.THINK_LOG_LEVEL ?? "warn" },
    bodyLimit: 32 * 1024 * 1024,
    trustProxy: true,
  });

  // Raw bodies for image uploads; JSON (and text/plain JSON from sendBeacon) otherwise.
  app.addContentTypeParser(/^image\//, { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // ---- optional built-in login (see auth.ts) ---------------------------------
  const auth = new Auth(path.join(paths.root, ".auth"));
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.addHook("onRequest", async (req, reply) => {
    if (!auth.enabled) return;
    const url = req.url.split("?")[0];
    if (url === "/api/health" || url === "/login") return;
    if (!auth.check(req.headers.cookie)) {
      if (url.startsWith("/api/") || url.startsWith("/ws/")) return reply.code(401).send({ error: "Sign in first." });
      return reply.redirect("/login");
    }
    // Signed in: writes and sockets must come from this app's own pages.
    const origin = req.headers.origin;
    if (origin && (req.method !== "GET" || url.startsWith("/ws/"))) {
      let host = "";
      try {
        host = new URL(origin).host;
      } catch {
        /* malformed */
      }
      if (host !== req.headers.host) return reply.code(403).send({ error: "Cross-site request refused." });
    }
  });
  app.get("/login", async (_req, reply) => reply.type("text/html; charset=utf-8").send(loginPage()));
  app.post("/login", async (req, reply) => {
    const forwarded = req.headers["x-forwarded-for"];
    const ip = (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "") || req.ip;
    const wait = auth.retryAfter(ip);
    if (wait) return reply.code(429).type("text/html; charset=utf-8").send(loginPage(`Too many attempts — try again in ${wait} s.`));
    const password = String((req.body as { password?: unknown } | null)?.password ?? "");
    const secure = req.headers["x-forwarded-proto"] === "https" || req.protocol === "https";
    const cookie = password ? auth.login(ip, password, secure) : null;
    if (!cookie) return reply.code(401).type("text/html; charset=utf-8").send(loginPage("That password is not right."));
    return reply.header("Set-Cookie", cookie).redirect("/", 303);
  });
  app.post("/api/logout", async (_req, reply) => reply.header("Set-Cookie", auth.logoutCookie()).send({ ok: true }));

  // ---- optional Cloudflare Access verification (defence in depth) ----------
  let jwks: { key: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;
  app.addHook("onRequest", async (req, reply) => {
    const cf = config.get().cfAccess;
    if (!cf || req.url === "/api/health") return;
    const certs = `https://${cf.teamDomain}/cdn-cgi/access/certs`;
    if (!jwks || jwks.key !== certs) jwks = { key: certs, set: createRemoteJWKSet(new URL(certs)) };
    const token = req.headers["cf-access-jwt-assertion"];
    if (typeof token !== "string") return reply.code(403).send({ error: "Missing Cloudflare Access assertion." });
    try {
      await jwtVerify(token, jwks.set, { issuer: `https://${cf.teamDomain}`, audience: cf.audience });
    } catch {
      return reply.code(403).send({ error: "Invalid Cloudflare Access assertion." });
    }
  });

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof UserError) return reply.code(400).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: "Internal error: " + errorMessage(err) });
  };

  await app.register(fastifyWebsocket, { options: { maxPayload: 32 * 1024 * 1024 } });

  // ---- API -------------------------------------------------------------------
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/info", async () => {
    const cfg = config.get();
    const providers = Object.values(config.providers()).map((p) => ({
      id: p.id,
      label: p.label,
      auth: p.auth,
      permissionMode: p.permissionMode ?? null,
      hasCredentials: p.credentialsFile ? fs.existsSync(path.join(providerHome(paths, p), p.credentialsFile)) : null,
      reportsUsage: !!p.usageCommand,
      // The variable's name and whether the server has it — never the key.
      apiKeyEnv: p.apiKeyEnv ?? null,
      apiKeyOnServer: !!(p.apiKeyEnv && process.env[p.apiKeyEnv]),
    }));
    return {
      version: deps.version,
      root: paths.root,
      config: {
        gridSize: cfg.gridSize,
        htmlLiveZoom: cfg.htmlLiveZoom,
        validationMaxAttempts: cfg.validationMaxAttempts,
        defaultAutosaveSeconds: cfg.defaultAutosaveSeconds,
        agentIdleShutdownSeconds: cfg.agentIdleShutdownSeconds,
        defaultProvider: cfg.defaultProvider,
        cfAccess: cfg.cfAccess !== null,
        passwordLogin: auth.enabled,
        agentPlacement: agentPlacement(),
      },
      namePool: config.namePool(),
      providers,
      openProjects: manager.openSlugs(),
    };
  });

  // Its own sign-in or the server's API key, for every canvas using it. Agents
  // that aren't working restart at once; working ones after their turn.
  app.post("/api/providers/:id/auth", async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = (req.body as { auth?: unknown } | null)?.auth;
    const provider = config.provider(id);
    if (!provider) return reply.code(404).send({ error: "Unknown provider." });
    if (auth !== "login" && auth !== "api-key") return reply.code(400).send({ error: 'auth must be "login" or "api-key".' });
    if (auth === "api-key") {
      if (!provider.apiKeyEnv) return reply.code(400).send({ error: `${provider.label} has no API-key mode.` });
      if (!process.env[provider.apiKeyEnv]) {
        return reply.code(400).send({ error: `The server has no ${provider.apiKeyEnv}. Add it to think's environment (the .env file) and restart think first.` });
      }
    }
    try {
      await config.setProviderAuth(id, auth);
    } catch (err) {
      return reply.code(400).send({ error: errorMessage(err) });
    }
    manager.providerChanged(id);
    return { ok: true, auth };
  });

  app.get("/api/providers/:id/usage", async (req, reply) => {
    const { id } = req.params as { id: string };
    const provider = config.provider(id);
    if (!provider) return reply.code(404).send({ error: "Unknown provider." });
    try {
      return { windows: await providerUsage(paths, provider) };
    } catch (err) {
      return reply.code(400).send({ error: errorMessage(err) });
    }
  });

  app.get("/api/projects", async () => {
    const list = await store.list();
    return list.map((p) => {
      const r = manager.peek(p.slug);
      return { ...p, open: !!r, working: r?.working ?? false };
    });
  });

  app.post("/api/projects", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: unknown; provider?: unknown; description?: unknown };
    try {
      if (typeof body.name !== "string") throw new UserError("A project needs a name.");
      const provider = typeof body.provider === "string" ? body.provider : config.get().defaultProvider;
      return await store.create(body.name, provider, typeof body.description === "string" ? body.description : undefined);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch("/api/projects/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = (req.body ?? {}) as { name?: unknown };
    try {
      if (typeof body.name !== "string" || !body.name.trim()) throw new UserError("A project needs a name.");
      // An open canvas renames through its runtime, so the commit is serialised
      // with its other git work and every tab hears about it.
      const open = manager.peek(slug);
      if (open) await open.renameCanvas(body.name);
      else await store.rename(slug, body.name.trim().slice(0, 100));
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get("/api/projects/:slug/files/:file", async (req, reply) => {
    const { slug, file } = req.params as { slug: string; file: string };
    const parsed = parseBlockFile(file);
    if (!SLUG_RE.test(slug) || !parsed) return reply.code(404).send({ error: "Not found." });
    const full = path.join(store.dir(slug), file);
    // ?rev=<commit>: the file as it was then (History previews).
    const rev = (req.query as { rev?: string }).rev;
    let data: Buffer;
    if (rev !== undefined) {
      if (!/^[0-9a-f]{7,40}$/.test(rev)) return reply.code(400).send({ error: "Bad revision." });
      const old = await showFile(store.dir(slug), rev, file);
      if (!old) return reply.code(404).send({ error: "Not found." });
      data = old;
      reply.header("Cache-Control", "private, max-age=31536000, immutable");
    } else {
      try {
        data = await fs.promises.readFile(full);
      } catch {
        return reply.code(404).send({ error: "Not found." });
      }
    }
    const mime = IMAGE_MIME[parsed.ext] ?? (parsed.ext === "html" ? "text/plain; charset=utf-8" : "text/plain; charset=utf-8");
    reply.header("Content-Type", mime);
    // Never render agent-written HTML as a page in our origin.
    reply.header("Content-Security-Policy", "sandbox");
    reply.header("X-Content-Type-Options", "nosniff");
    if (rev === undefined) reply.header("Cache-Control", "no-cache");
    if ((req.query as { download?: string }).download !== undefined) {
      reply.header("Content-Disposition", `attachment; filename="${file}"`);
    }
    return reply.send(data);
  });

  // The original image under a drawing (.drawings/<name>/base.*), for the drawing editor.
  app.get("/api/projects/:slug/drawings/:name/base", async (req, reply) => {
    const { slug, name } = req.params as { slug: string; name: string };
    const q = req.query as { file?: string };
    if (!SLUG_RE.test(slug) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return reply.code(404).send({ error: "Not found." });
    // A named original (the editor asks for its page's file), or the drawing's current one.
    let file = typeof q.file === "string" && BASE_FILE_RE.test(q.file) ? q.file : null;
    if (!file) {
      const d = await readDrawing(store.dir(slug), name);
      if (!d || d.base.kind !== "image") return reply.code(404).send({ error: "Not found." });
      file = d.base.file;
    }
    let data: Buffer;
    try {
      data = await fs.promises.readFile(path.join(sidecarDir(store.dir(slug), name), file));
    } catch {
      return reply.code(404).send({ error: "Not found." });
    }
    reply.header("Content-Type", IMAGE_MIME[file.split(".").pop()!] ?? "application/octet-stream");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-cache");
    return reply.send(data);
  });

  // Read one block straight from disk — no runtime, no agent. For the render-only route.
  app.get("/api/projects/:slug/blocks/:name", async (req, reply) => {
    const { slug, name } = req.params as { slug: string; name: string };
    if (!SLUG_RE.test(slug) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return reply.code(404).send({ error: "Not found." });
    let files: string[];
    try {
      files = await fs.promises.readdir(store.dir(slug));
    } catch {
      return reply.code(404).send({ error: "Not found." });
    }
    const candidates = files
      .map((f) => ({ f, p: parseBlockFile(f) }))
      .filter((x) => x.p && x.p.name === name)
      .sort((a, b) => EXTENSION_PRECEDENCE.indexOf(a.p!.ext) - EXTENSION_PRECEDENCE.indexOf(b.p!.ext));
    const hit = candidates[0];
    if (!hit) return reply.code(404).send({ error: "Not found." });
    const content = hit.p!.type === "image" ? undefined : await fs.promises.readFile(path.join(store.dir(slug), hit.f), "utf8");
    return { name, file: hit.f, type: hit.p!.type, content };
  });

  const runtimeFor = async (slug: string): Promise<ProjectRuntime> => {
    if (!SLUG_RE.test(slug)) throw new UserError("Invalid project.");
    const r = manager.peek(slug);
    if (!r) throw new UserError("Open the project first.");
    return r;
  };

  app.post("/api/projects/:slug/images", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const q = req.query as { x?: string; y?: string; replace?: string };
    try {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) throw new UserError("Send the image as the request body.");
      const runtime = await runtimeFor(slug);
      const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim();
      return await runtime.putImage(body, mime, {
        x: q.x !== undefined ? Number(q.x) : undefined,
        y: q.y !== undefined ? Number(q.y) : undefined,
        replace: q.replace || undefined,
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/projects/:slug/drawings/:name/base", async (req, reply) => {
    const { slug, name } = req.params as { slug: string; name: string };
    try {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) throw new UserError("Send the image as the request body.");
      const runtime = await runtimeFor(slug);
      return await runtime.putDrawingBase(name, body, String(req.headers["content-type"] ?? "").split(";")[0].trim());
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/api/projects/:slug/beacon", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = (req.body ?? {}) as { edits?: { name: string; content: string }[]; drawings?: { name: string; drawing: unknown; history?: unknown }[] };
    try {
      const runtime = await runtimeFor(slug);
      for (const e of body.edits ?? []) {
        if (typeof e?.name === "string" && typeof e?.content === "string") await runtime.handle(beaconClient, { type: "user.edit", name: e.name, content: e.content });
      }
      for (const d of body.drawings ?? []) {
        if (typeof d?.name === "string" && d.drawing) await runtime.handle(beaconClient, { type: "drawing.save", name: d.name, drawing: d.drawing as never, history: d.history });
      }
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---- WebSocket ---------------------------------------------------------------
  app.get("/ws/projects/:slug", { websocket: true }, (socket, req: FastifyRequest) => {
    const { slug } = req.params as { slug: string };
    const client: ClientConn = {
      id: newId("c-"),
      send: (msg: ServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      },
    };
    let runtime: ProjectRuntime | null = null;
    const backlog: ClientMessage[] = [];
    let alive = true;

    const dispatch = async (msg: ClientMessage) => {
      try {
        const result = await runtime!.handle(client, msg);
        if (msg.ref) client.send({ type: "ack", ref: msg.ref, ok: true, result });
      } catch (err) {
        const message = err instanceof UserError ? err.message : `Something went wrong: ${errorMessage(err)}`;
        if (!(err instanceof UserError)) app.log.error(err);
        if (msg.ref) client.send({ type: "ack", ref: msg.ref, ok: false, error: message });
        else client.send({ type: "error", message });
      }
    };

    // Handlers are attached before any async work so no message is dropped.
    socket.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
        if (!msg || typeof msg.type !== "string") throw new Error("no type");
      } catch {
        client.send({ type: "error", message: "Malformed message." });
        return;
      }
      if (runtime) void dispatch(msg);
      else backlog.push(msg);
    });
    socket.on("pong", () => {
      alive = true;
    });
    const ping = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, PING_MS);
    socket.on("close", () => {
      clearInterval(ping);
      runtime?.detach(client.id);
    });

    manager
      .get(slug)
      .then(async (r) => {
        if (socket.readyState !== socket.OPEN) return;
        runtime = r;
        r.attach(client);
        // Preserve order: backlog first, then live messages.
        for (const m of backlog.splice(0)) await dispatch(m);
      })
      .catch((err) => {
        const known = err instanceof UserError || err instanceof NewerFormatError;
        client.send({ type: "error", message: known ? err.message : `Could not open the project: ${errorMessage(err)}` });
        // The close reason is capped at 123 bytes; the tab shows it as the explanation.
        socket.close(4404, known && Buffer.byteLength(err.message) <= 123 ? err.message : "project unavailable");
      });
  });

  // ---- client ------------------------------------------------------------------
  if (deps.serveClient && fs.existsSync(paths.clientDir)) {
    await app.register(fastifyStatic, { root: paths.clientDir, wildcard: false, index: false, maxAge: "1h", immutable: false });
    const index = fs.readFileSync(path.join(paths.clientDir, "index.html"));
    app.get("/assets/*", async (req, reply) => {
      const rel = (req.params as { "*": string })["*"];
      reply.header("Cache-Control", "public, max-age=31536000, immutable");
      return reply.sendFile(path.join("assets", rel));
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== "GET" || req.url.startsWith("/api/") || req.url.startsWith("/ws/")) {
        return reply.code(404).send({ error: "Not found." });
      }
      const file = req.url.split("?")[0].slice(1);
      if (file && !file.includes("..") && fs.existsSync(path.join(paths.clientDir, file)) && fs.statSync(path.join(paths.clientDir, file)).isFile()) {
        return reply.sendFile(file);
      }
      reply.header("Cache-Control", "no-cache");
      return reply.type("text/html").send(index);
    });
  }

  return app;
}

/** Edits delivered by sendBeacon have no socket; they are broadcast to every tab. */
const beaconClient: ClientConn = { id: "beacon", send: () => {} };
