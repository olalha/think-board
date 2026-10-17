// One tooltip for the whole app, for any element with `data-tip` (placement:
// `data-tip-pos` = bottom (default) | top | left | right).
//
// Drawn in its own layer above everything, so a scrolling panel or a menu can't
// cut it off, and flipped / shifted to stay on screen. Mouse and keyboard only:
// on a touch screen a tap would leave it covering what is next to the button
// (every button carries an aria-label for screen readers anyway).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Pos = "top" | "bottom" | "left" | "right";
type Tip = { el: HTMLElement; text: string; pos: Pos };

const GAP = 6;
const MARGIN = 8;
const DELAY = 350;
/** Moving straight from one tooltip to the next shows it at once, like native ones. */
const WARM = 400;

function tipTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? (node.closest("[data-tip]") as HTMLElement | null) : null;
}

function read(el: HTMLElement): Tip | null {
  const text = el.getAttribute("data-tip");
  if (!text) return null;
  const p = el.getAttribute("data-tip-pos");
  return { el, text, pos: p === "top" || p === "left" || p === "right" ? p : "bottom" };
}

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hover = window.matchMedia("(hover: hover) and (pointer: fine)");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shown: HTMLElement | null = null;
    let hiddenAt = 0;
    const hide = () => {
      clearTimeout(timer);
      if (shown) hiddenAt = Date.now();
      shown = null;
      setTip(null);
    };
    const show = (el: HTMLElement, now = false) => {
      clearTimeout(timer);
      const go = () => {
        const t = read(el);
        if (!t || !el.isConnected) return;
        shown = el;
        setTip(t);
      };
      if (now || Date.now() - hiddenAt < WARM) go();
      else timer = setTimeout(go, DELAY);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || !hover.matches) return;
      const el = tipTarget(e.target);
      if (el === shown) return;
      if (!el) return hide();
      if (shown) {
        hide();
        show(el, true);
      } else show(el);
    };
    const out = (e: PointerEvent) => {
      const el = tipTarget(e.target);
      if (!el || (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) return;
      if (el === shown || !shown) hide();
    };
    // Keyboard focus shows it (focus-visible only: not after a click).
    const focusIn = (e: FocusEvent) => {
      const el = tipTarget(e.target);
      if (el && el === e.target && el.matches(":focus-visible")) show(el);
    };
    const focusOut = (e: FocusEvent) => {
      if (tipTarget(e.target) === shown) hide();
    };
    const down = () => hide();
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("focusin", focusIn, true);
    document.addEventListener("focusout", focusOut, true);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("wheel", down, { capture: true, passive: true });
    document.addEventListener("keydown", down, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("focusin", focusIn, true);
      document.removeEventListener("focusout", focusOut, true);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("wheel", down, true);
      document.removeEventListener("keydown", down, true);
    };
  }, []);

  // Follow the element while shown (it may move, change its text or go away).
  useLayoutEffect(() => {
    if (!tip) return;
    let raf = 0;
    const place = () => {
      const b = box.current;
      if (!b) return;
      if (!tip.el.isConnected) return setTip(null);
      const text = tip.el.getAttribute("data-tip");
      if (!text) return setTip(null);
      if (b.textContent !== text) b.textContent = text;
      const r = tip.el.getBoundingClientRect();
      const w = b.offsetWidth;
      const h = b.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let pos = tip.pos;
      // Flip to the other side when there is no room on the preferred one.
      if (pos === "bottom" && r.bottom + GAP + h > vh - MARGIN && r.top - GAP - h >= MARGIN) pos = "top";
      else if (pos === "top" && r.top - GAP - h < MARGIN) pos = "bottom";
      else if (pos === "left" && r.left - GAP - w < MARGIN) pos = "right";
      else if (pos === "right" && r.right + GAP + w > vw - MARGIN) pos = "left";
      let x: number;
      let y: number;
      if (pos === "top" || pos === "bottom") {
        x = r.left + r.width / 2 - w / 2;
        y = pos === "bottom" ? r.bottom + GAP : r.top - GAP - h;
      } else {
        x = pos === "right" ? r.right + GAP : r.left - GAP - w;
        y = r.top + r.height / 2 - h / 2;
      }
      // Shift along the edge to stay on screen.
      x = Math.max(MARGIN, Math.min(x, vw - MARGIN - w));
      y = Math.max(MARGIN, Math.min(y, vh - MARGIN - h));
      b.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={box} className="tip" role="tooltip">
      {tip.text}
    </div>,
    document.body,
  );
}
