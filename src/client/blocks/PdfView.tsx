// A PDF, page under page, drawn by pdf.js into canvases. Loaded lazily (see
// `PdfView` in renderers.tsx) so pdf.js stays out of the main bundle. Only the
// pages near the visible part are drawn; pages far away give their canvas
// back, so a long PDF costs a few pages' worth of memory.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { openPdf } from "../lib/pdf";

/** The most pixels one page's canvas may hold (about 16 MB of bitmap). */
const MAX_CANVAS_PIXELS = 4_000_000;
/** …and the longest side, which some browsers cap. */
const MAX_CANVAS_SIDE = 4096;
/** Zoomed out, pages are drawn at this fraction of full sharpness. */
const THUMB_FACTOR = 0.5;
/** Padding around the pages, in CSS pixels (matches .pdf-pages in blocks.css). */
const PAD = 8;

export interface PdfViewProps {
  src: string;
  /** "thumb": the canvas is zoomed out, so the pages are drawn less sharp. */
  quality?: "full" | "thumb";
  /** Classes for the scrolling element (`nowheel` when the block is selected). */
  scrollClass?: string;
}

export default function PdfView({ src, quality = "full", scrollClass = "" }: PdfViewProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Each page's height / width; the first page's until a page is seen. */
  const [aspects, setAspects] = useState<number[]>([]);
  const [current, setCurrent] = useState(1);
  const [width, setWidth] = useState(0);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const pages = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    setDoc(null);
    setError(null);
    setCurrent(1);
    const handle = openPdf(src);
    let live = true;
    handle.doc
      .then(async (d) => {
        const vp = (await d.getPage(1)).getViewport({ scale: 1 });
        if (!live) return;
        setAspects(Array.from({ length: d.numPages }, () => vp.height / vp.width));
        setDoc(d);
      })
      .catch((err: Error) => {
        if (!live) return;
        setError(err?.name === "PasswordException" ? "This PDF is password-protected." : "This PDF could not be opened.");
      });
    return () => {
      live = false;
      handle.release();
    };
  }, [src]);

  // The width pages are drawn at: the block's, in canvas pixels (settled, so a resize redraws once).
  useEffect(() => {
    if (!root) return;
    let timer = 0;
    const measure = () => setWidth(Math.max(0, root.clientWidth - 2 * PAD));
    measure();
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, 150);
    });
    ro.observe(root);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [root]);

  const onAspect = useCallback((i: number, a: number) => {
    setAspects((prev) => (Math.abs((prev[i] ?? 0) - a) < 0.001 ? prev : prev.map((x, j) => (j === i ? a : x))));
  }, []);

  const onScroll = () => {
    if (!root) return;
    const mark = root.scrollTop + root.clientHeight / 3;
    let n = 1;
    pages.current.forEach((el, i) => {
      if (el && el.offsetTop <= mark) n = i + 1;
    });
    setCurrent(n);
  };

  if (error) return <div className="pdf-message">{error}</div>;
  return (
    <div className="pdf-view">
      <div ref={setRoot} className={`pdf-pages ${scrollClass}`} onScroll={onScroll}>
        {doc && root
          ? aspects.map((a, i) => (
              <PdfPage
                key={i}
                setRef={(el) => {
                  pages.current[i] = el;
                }}
                doc={doc}
                index={i}
                aspect={a}
                width={width}
                factor={quality === "thumb" ? THUMB_FACTOR : 1}
                root={root}
                onAspect={onAspect}
              />
            ))
          : !doc && <div className="pdf-message"><span className="spinner" /></div>}
      </div>
      {doc && (
        <div className="pdf-pager" aria-live="polite">
          {doc.numPages === 1 ? "1 page" : `Page ${current} of ${doc.numPages}`}
        </div>
      )}
    </div>
  );
}

interface PageProps {
  setRef: (el: HTMLDivElement | null) => void;
  doc: PDFDocumentProxy;
  index: number;
  aspect: number;
  width: number;
  factor: number;
  root: HTMLDivElement;
  onAspect: (index: number, aspect: number) => void;
}

function PdfPage({ setRef, doc, index, aspect, width, factor, root, onAspect }: PageProps) {
  const box = useRef<HTMLDivElement | null>(null);
  // The drawn canvas lives here, managed by hand: a redraw goes into a fresh
  // canvas that replaces the old one only when done (no flash, and pdf.js never
  // draws into a canvas twice at once).
  const holder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // Near: within one screenful of the visible part of the block.
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root, rootMargin: "100% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const out = holder.current;
    if (!out) return;
    if (!near || width <= 0) {
      out.replaceChildren(); // far away: give the memory back
      return;
    }
    let task: RenderTask | null = null;
    let cancelled = false;
    void (async () => {
      const page = await doc.getPage(index + 1);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      onAspect(index, base.height / base.width);
      const dpr = window.devicePixelRatio || 1;
      const scale = Math.min(
        (width * dpr * factor) / base.width,
        Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height)),
        MAX_CANVAS_SIDE / base.width,
        MAX_CANVAS_SIDE / base.height,
      );
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      task = page.render({ canvas, viewport });
      await task.promise;
      if (!cancelled) out.replaceChildren(canvas);
    })().catch(() => {
      /* cancelled, or a broken page: it stays blank */
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, doc, index, width, factor, onAspect]);

  return (
    <div
      ref={(el) => {
        box.current = el;
        setRef(el);
      }}
      className="pdf-page"
      style={{ aspectRatio: `1 / ${aspect}` }}
      aria-label={`Page ${index + 1}`}
    >
      <div ref={holder} className="pdf-canvas" />
    </div>
  );
}
