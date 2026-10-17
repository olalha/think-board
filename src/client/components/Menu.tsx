// Floating menu used for context menus and dropdowns. Keyboard navigable,
// clamped to the viewport, closes on outside click, Escape, or scroll.
// Rendered into <body> through a portal: an ancestor with a transform (the
// sliding chat panel) would otherwise become the origin of `position: fixed`
// and push the menu off-screen.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

export type MenuEntry =
  | {
      kind?: "item";
      label: string;
      icon?: ReactNode;
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      onSelect: () => void;
    }
  | { kind: "sep" }
  | { kind: "heading"; label: string }
  /** A row of colours to pick from (e.g. "Blank page" and its page colours). */
  | { kind: "swatches"; label: string; icon?: ReactNode; hint?: string; disabled?: boolean; colors: { color: string; name: string }[]; onPick: (color: string) => void };

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const actionable = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => (it.kind ?? "item") === "item" && !(it as { disabled?: boolean }).disabled);
  const [focus, setFocus] = useState(-1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    const top = y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height) : y;
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const n = actionable.length;
        if (!n) return;
        setFocus((f) => (e.key === "ArrowDown" ? (f + 1) % n : (f - 1 + n) % n));
      } else if (e.key === "Enter" && focus >= 0) {
        e.preventDefault();
        e.stopPropagation();
        const entry = actionable[focus]?.it as { onSelect: () => void } | undefined;
        onClose();
        entry?.onSelect();
      }
    };
    const blur = () => onClose();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", blur);
    };
  }, [onClose, actionable, focus]);

  const focusedIndex = focus >= 0 ? actionable[focus]?.i : -1;

  return createPortal(
    <div ref={ref} className="menu" role="menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) => {
        if (it.kind === "sep") return <div key={i} className="menu-sep" />;
        if (it.kind === "heading") return <div key={i} className="menu-heading">{it.label}</div>;
        if (it.kind === "swatches")
          return (
            <div key={i} className={`menu-item menu-swatches ${it.disabled ? "disabled" : ""}`} role="group" aria-label={it.label}>
              <span className="menu-icon">{it.icon}</span>
              <span className="menu-label">{it.label}</span>
              <span className="menu-swatch-row">
                {it.colors.map((c) => (
                  <button
                    key={c.color}
                    role="menuitem"
                    className="menu-swatch"
                    style={{ background: c.color }}
                    aria-label={`${it.label}: ${c.name}`}
                    data-tip={c.name}
                    disabled={it.disabled}
                    onClick={() => {
                      onClose();
                      it.onPick(c.color);
                    }}
                  />
                ))}
              </span>
              {it.hint && <span className="menu-hint">{it.hint}</span>}
            </div>
          );
        return (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${it.danger ? "danger" : ""} ${focusedIndex === i ? "focused" : ""}`}
            disabled={it.disabled}
            onMouseEnter={() => setFocus(actionable.findIndex((a) => a.i === i))}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            <span className="menu-icon">{it.checked !== undefined ? (it.checked ? <Check size={15} /> : null) : it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
