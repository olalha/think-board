// Pure block renderers.
//
// These take content in and draw it — no store, no network, no canvas. The
// board uses them inside blocks, and the render-only route (/render/…) uses
// the very same components, which is what a future annotation feature needs
// to screenshot a block exactly as the user sees it.

import { lazy, memo, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, ImageOff } from "lucide-react";
import { withTheme } from "./html-theme";
import { displayName, parseBlockFile } from "../../shared/blocks";
import { remarkBlockLinks } from "./block-links";
import { cachedMermaid, renderMermaid, type MermaidResult } from "./mermaid";
import type { PdfViewProps } from "./PdfView";

// ---------------------------------------------------------------- pdf

// pdf.js is large: the viewer and the library load on the first PDF shown.
const LazyPdfView = lazy(() => import("./PdfView"));

/** A PDF, its pages one under another, drawn only near the visible part. */
export function PdfView(props: PdfViewProps) {
  return (
    <Suspense fallback={<div className="pdf-message"><span className="spinner" /></div>}>
      <LazyPdfView {...props} />
    </Suspense>
  );
}

// ---------------------------------------------------------------- markdown

/** How a `[[name]]` link reads: the block's label, and whether the block exists. */
export type LinkResolver = (name: string) => { label: string; exists: boolean };

/**
 * A `[[name]]` link as a chip: "@Label" (or the link's own text). It flies to
 * the block when `onClick` is given; a link to no block is struck through.
 * Without a resolver (copying, the render route) it reads as the name made readable.
 */
function BlockLinkChip({ name, text, resolve, onClick }: { name: string; text?: string; resolve?: LinkResolver; onClick?: (name: string) => void }) {
  const r = resolve?.(name) ?? { label: displayName(name), exists: true };
  const shown = text?.trim() ? text : `@${r.label}`;
  if (!r.exists) {
    return (
      <span className="block-link missing" data-block={name} data-tip={`No block named “${name}”`}>
        {shown}
      </span>
    );
  }
  if (!onClick) {
    return (
      <span className="block-link" data-block={name}>
        {shown}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="block-link nodrag"
      data-block={name}
      data-tip={text?.trim() ? `Go to ${r.label}` : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onClick(name);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {shown}
    </button>
  );
}

const PLUGINS = [remarkGfm, remarkBlockLinks];

export const MarkdownView = memo(function MarkdownView({
  source,
  resolveFile,
  resolveLink,
  onLinkClick,
}: {
  source: string;
  /** Maps a bare block filename (e.g. `sally.png`) to a URL, so Markdown can embed canvas images. */
  resolveFile?: (file: string) => string | null;
  /** Labels `[[name]]` links and says whether their block exists. */
  resolveLink?: LinkResolver;
  /** Makes `[[name]]` links clickable. */
  onLinkClick?: (name: string) => void;
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
      span: ({ node: _node, ...props }) => {
        const p = props as Record<string, unknown>;
        const name = p["data-block"];
        if (typeof name !== "string") return <span {...props} />;
        const text = typeof p["data-text"] === "string" ? (p["data-text"] as string) : undefined;
        return <BlockLinkChip name={name} text={text} resolve={resolveLink} onClick={onLinkClick} />;
      },
    }),
    [resolveFile, resolveLink, onLinkClick],
  );
  if (!source.trim()) return <div className="md-empty">Empty — switch to raw to write.</div>;
  return (
    <div className="md">
      <Markdown remarkPlugins={PLUGINS} components={components}>
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
