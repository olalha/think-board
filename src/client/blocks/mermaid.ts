// Client-side Mermaid rendering.
//
// Loaded lazily (it is large), rendered one diagram at a time (mermaid keeps
// global state), and cached by theme + source so re-mounting a block — or
// panning it back into view — costs nothing. The server validates with the
// very same mermaid package (one package.json), so both agree on what parses.

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | null = null;
let initializedTheme: string | null = null;
let chain: Promise<unknown> = Promise.resolve();
let seq = 0;

export type MermaidResult = { svg: string; error?: undefined } | { svg?: undefined; error: string };

const cache = new Map<string, MermaidResult>();
const MAX_CACHE = 300;

function load(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  return loading;
}

export function cachedMermaid(source: string, theme: "light" | "dark"): MermaidResult | undefined {
  return cache.get(theme + "\0" + source);
}

/** Make the SVG scale to its container (keeps the aspect ratio via viewBox). */
function fitSvg(svg: string): string {
  return svg.replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
    const cleaned = attrs
      .replace(/\swidth="[^"]*"/, "")
      .replace(/\sheight="[^"]*"/, "")
      .replace(/max-width:\s*[^;"]+;?/, "");
    return `<svg${cleaned} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">`;
  });
}

function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+$/, "");
}

export function renderMermaid(source: string, theme: "light" | "dark"): Promise<MermaidResult> {
  const key = theme + "\0" + source;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const job = chain.then(async (): Promise<MermaidResult> => {
    const again = cache.get(key);
    if (again) return again;
    const mermaid = await load();
    if (initializedTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: theme === "dark" ? "dark" : "default",
        fontFamily: '"Inter Variable", -apple-system, "Segoe UI", sans-serif',
        flowchart: { htmlLabels: true, curve: "basis" },
      });
      initializedTheme = theme;
    }
    let result: MermaidResult;
    const id = `mmd-${++seq}`;
    try {
      if (!source.trim()) throw new Error("The diagram is empty.");
      await mermaid.parse(source);
      const { svg } = await mermaid.render(id, source);
      result = { svg: fitSvg(svg) };
    } catch (err) {
      result = { error: cleanError(err) };
      document.getElementById(id)?.remove();
      document.getElementById("d" + id)?.remove();
    }
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return result;
  });
  chain = job.catch(() => undefined);
  return job;
}
