// Pure block renderers.
//
// These take content in and draw it — no store, no network, no canvas. The
// board uses them inside blocks, and the render-only route (/render/…) uses
// the very same components, which is what a future annotation feature needs
// to screenshot a block exactly as the user sees it.

import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, ImageOff } from "lucide-react";
import { withTheme } from "./html-theme";
import { parseBlockFile } from "../../shared/blocks";
import { cachedMermaid, renderMermaid, type MermaidResult } from "./mermaid";

// ---------------------------------------------------------------- markdown

export const MarkdownView = memo(function MarkdownView({
  source,
  resolveFile,
}: {
  source: string;
  /** Maps a bare block filename (e.g. `sally.png`) to a URL, so Markdown can embed canvas images. */
  resolveFile?: (file: string) => string | null;
}) {
  const components = useMemo<Components>(
    () => ({
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      img: ({ node: _node, src, alt, ...props }) => {
        let url = typeof src === "string" ? src : "";
        if (url && resolveFile && parseBlockFile(url.replace(/^\.\//, ""))) url = resolveFile(url.replace(/^\.\//, "")) ?? url;
        return <img {...props} src={url} alt={alt ?? ""} loading="lazy" />;
      },
      input: ({ node: _node, ...props }) => <input {...props} disabled />,
    }),
    [resolveFile],
  );
  if (!source.trim()) return <div className="md-empty">Empty — switch to raw to write.</div>;
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </Markdown>
    </div>
  );
});

// ---------------------------------------------------------------- mermaid

export function useMermaid(source: string, theme: "light" | "dark"): MermaidResult | null {
  const [result, setResult] = useState<MermaidResult | null>(() => cachedMermaid(source, theme) ?? null);
  useEffect(() => {
    let live = true;
    const hit = cachedMermaid(source, theme);
    if (hit) {
      setResult(hit);
      return;
    }
    // Keep showing the previous diagram while the new one renders (no flicker while typing).
    const t = setTimeout(() => {
      void renderMermaid(source, theme).then((r) => live && setResult(r));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [source, theme]);
  return result;
}

export const MermaidView = memo(function MermaidView({
  source,
  theme,
  errorActions,
}: {
  source: string;
  theme: "light" | "dark";
  /** Rendered under a parse error, e.g. the "Revert to last valid version" button. */
  errorActions?: ReactNode;
}) {
  const result = useMermaid(source, theme);
  if (!result) return <div className="mermaid-view loading"><span className="spinner" /></div>;
  if (result.error !== undefined) {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error-title">
          <AlertTriangle size={15} /> This diagram doesn't parse
        </div>
        <pre>{result.error}</pre>
        {errorActions}
      </div>
    );
  }
  return <div className="mermaid-view" dangerouslySetInnerHTML={{ __html: result.svg }} />;
});

// ---------------------------------------------------------------- html

/**
 * HTML blocks run in a sandboxed iframe: scripts yes, same origin never —
 * the page cannot reach the app, its cookies or its API.
 *
 * Inside a frame, `prefers-color-scheme` answers with the computer's setting,
 * not think's. So with a theme given, the page is told think's: its
 * `(prefers-color-scheme: …)` queries — in CSS and in matchMedia() — are
 * rewritten to always / never match, and the page's color-scheme is pinned.
 */
export const HtmlView = memo(function HtmlView({ source, title, theme }: { source: string; title: string; theme?: "light" | "dark" }) {
  const doc = useMemo(() => (theme ? withTheme(source, theme) : source), [source, theme]);
  return <iframe className="html-frame" title={title} sandbox="allow-scripts" srcDoc={doc} referrerPolicy="no-referrer" />;
});



// ---------------------------------------------------------------- image

export const ImageView = memo(function ImageView({ src, alt }: { src: string; alt: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (broken) {
    return (
      <div className="image-broken">
        <ImageOff size={22} />
        <span>This image can't be displayed.</span>
      </div>
    );
  }
  return <img className="image-view" src={src} alt={alt} draggable={false} onError={() => setBroken(true)} />;
});
