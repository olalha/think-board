// What `[[name]]` chips in rendered Markdown need from the board: each
// block's label and whether it exists (MarkdownView is a pure renderer), and
// what a click does.
import { useMemo } from "react";
import { blockLabel, displayName } from "../../shared/blocks";
import type { LinkResolver } from "../blocks/renderers";
import { useBoard, type BoardState } from "../lib/store";
import { followLink } from "./actions";

/**
 * A key that changes only when a block appears, goes or is retitled — not on
 * every edit or move — so the chips (and the Markdown around them) re-render
 * only then. Worked out once per store state, however many blocks ask.
 */
let memo: { blocks: BoardState["blocks"]; canvas: BoardState["canvas"]; key: string } | null = null;
function labelsKey(s: BoardState): string {
  if (memo && memo.blocks === s.blocks && memo.canvas === s.canvas) return memo.key;
  const titles = s.canvas.nodes.flatMap((n) => (n.type === "file" && n.title ? [`${n.id}\t${n.title}`] : []));
  const key = `${Object.keys(s.blocks).sort().join("\n")}\u0000${titles.sort().join("\n")}`;
  memo = { blocks: s.blocks, canvas: s.canvas, key };
  return key;
}

/** Props for MarkdownView that make its `[[links]]` live: `<MarkdownView {...useLinkChips()} … />`. */
export function useLinkChips(): { resolveLink: LinkResolver; onLinkClick: (name: string) => void } {
  const key = useBoard(labelsKey);
  return useMemo(() => {
    const [names, titleLines] = key.split("\u0000");
    const exists = new Set(names ? names.split("\n") : []);
    const titles = new Map(titleLines ? titleLines.split("\n").map((l) => l.split("\t") as [string, string]) : []);
    const resolveLink: LinkResolver = (name) =>
      exists.has(name) ? { label: blockLabel(name, { title: titles.get(name) }), exists: true } : { label: displayName(name), exists: false };
    return { resolveLink, onLinkClick: followLink };
  }, [key]);
}
