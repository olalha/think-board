// Plan usage for providers that expose it as a local command (claude-agent-acp:
// "/usage"). A short-lived ACP connection runs the command — no model call, and
// the agent reads its own credentials; we only parse the Markdown it prints.

import { spawnProcess } from "./process.js";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Paths, ProviderConfig } from "../config.js";
import { agentEnv, providerHome } from "./env.js";

export interface UsageWindow {
  label: string;
  percent: number;
  resets: string | null;
}

const cache = new Map<string, { at: number; value: UsageWindow[] }>();

/** "**5-hour limit** — **64%** · Resets Sep 26, 8:00 PM GMT+2" → a window. */
export function parseUsage(markdown: string): UsageWindow[] {
  const out: UsageWindow[] = [];
  const re = /\*\*([^*]+?)\*\*\s*—\s*\*\*(\d+(?:\.\d+)?)%\*\*(?:\s*·\s*Resets\s+([^\n]+))?/g;
  for (const m of markdown.matchAll(re)) out.push({ label: m[1].trim(), percent: Number(m[2]), resets: m[3]?.trim() ?? null });
  return out;
}

export async function providerUsage(paths: Paths, provider: ProviderConfig): Promise<UsageWindow[]> {
  if (!provider.usageCommand) throw new Error("This provider does not report plan usage.");
  const hit = cache.get(provider.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const cwd = path.join(providerHome(paths, provider), "usage-probe");
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawnProcess({ command: provider.command, args: provider.args, cwd, env: agentEnv(paths, provider) });
  child.stderr.resume();
  let text = "";
  const conn = acp
    .client({ name: "think-usage" })
    .onRequest(acp.methods.client.session.requestPermission, async () => ({ outcome: { outcome: "cancelled" } }))
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const u = ctx.params.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") text += u.content.text;
    })
    .connect(acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    await conn.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const s = await conn.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [], _meta: provider.sessionMeta });
    await conn.agent.request(acp.methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: "text", text: provider.usageCommand }] });
  } finally {
    clearTimeout(timeout);
    conn.close();
    child.kill("SIGTERM");
  }
  const value = parseUsage(text);
  if (!value.length) throw new Error("The agent did not report usage (is it logged in with a subscription?).");
  cache.set(provider.id, { at: Date.now(), value });
  return value;
}
