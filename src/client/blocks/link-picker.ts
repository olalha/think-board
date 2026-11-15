// The @ picker in the Markdown editor: typing `@` at the start of a word, or
// `[[`, lists the canvas's blocks (by title and by name, fuzzy); picking one
// writes the link, `[[name]]`, in place of what was typed. Esc closes the list
// (CodeMirror's completion keymap runs before the editor's own Esc, which
// leaves the editor, and only acts while the list is open).

import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { tooltips, type EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { BlockType } from "../../shared/blocks";
import { fuzzy } from "../lib/fuzzy";

/** What the text before the cursor asks for: `@tea` or `[[tea`, and where that starts. */
export interface LinkTrigger {
  kind: "at" | "brackets";
  query: string;
  /** How many characters before the cursor the trigger takes (`@` or `[[` included). */
  length: number;
}

/**
 * The trigger at the end of `before` (the line up to the cursor), if any. `@`
 * counts only at a word start, so `me@example.com` lists nothing; the query
 * stops at spaces and brackets.
 */
export function linkTrigger(before: string): LinkTrigger | null {
  const br = /\[\[([^[\]|\n]*)$/.exec(before);
  if (br && !before.slice(0, br.index).endsWith("[")) return { kind: "brackets", query: br[1], length: br[0].length };
  const at = /(?:^|[\s([{>"'*_~])@([^\s@[\]()]*)$/.exec(before);
  if (at) return { kind: "at", query: at[1], length: at[1].length + 1 };
  return null;
}

export interface PickerBlock {
  name: string;
  label: string;
  type: BlockType;
}

/** The blocks matching `query` (by label, or by name), best first; everything, by label, for no query. */
export function rankBlocks(query: string, blocks: readonly PickerBlock[], limit = 40): PickerBlock[] {
  const q = query.trim();
  if (!q) return [...blocks].sort((a, b) => a.label.localeCompare(b.label)).slice(0, limit);
  const scored: { b: PickerBlock; score: number }[] = [];
  for (const b of blocks) {
    const byLabel = fuzzy(q, b.label);
    const byName = fuzzy(q, b.name);
    const score = Math.max(byLabel?.score ?? -Infinity, byName ? byName.score - 0.5 : -Infinity);
    if (score > -Infinity) scored.push({ b, score });
  }
  return scored
    .sort((x, y) => y.score - x.score || x.b.label.localeCompare(y.b.label))
    .slice(0, limit)
    .map((s) => s.b);
}

const TYPE_NAME: Record<BlockType, string> = { markdown: "Markdown", mermaid: "Diagram", html: "HTML", image: "Image", pdf: "PDF" };

/** Syntax nodes whose text is code: a link typed there would be text, so nothing is offered. */
const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "CodeText", "CodeMark"]);

function inCode(ctx: CompletionContext): boolean {
  type Node = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;
  for (let n: Node | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); n; n = n.parent) {
    if (CODE_NODES.has(n.name)) return true;
  }
  return false;
}

/**
 * The picker, for a Markdown block's editor. `blocks` is read when the list
 * opens, so it always shows the canvas as it is; `self` (the block being
 * edited) is left out.
 */
export function linkPicker(blocks: () => PickerBlock[], self: string): Extension {
  const source = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const trigger = linkTrigger(line.text.slice(0, ctx.pos - line.from));
    if (!trigger || inCode(ctx)) return null;
    const from = ctx.pos - trigger.length;
    const options: Completion[] = rankBlocks(
      trigger.query,
      blocks().filter((b) => b.name !== self),
    ).map((b) => ({
      label: b.label,
      detail: b.label.toLowerCase() === b.name.replace(/-/g, " ") ? TYPE_NAME[b.type] : `${b.name} · ${TYPE_NAME[b.type]}`,
      type: `tb-${b.type}`,
      apply: (view: EditorView, _c: Completion, at: number, to: number) => {
        // `[` closes itself as you type, so `[[tea` may have `]]` after the cursor: take it too.
        let end = to;
        if (trigger.kind === "brackets") {
          const after = view.state.sliceDoc(to, to + 2);
          end += after === "]]" ? 2 : after.startsWith("]") ? 1 : 0;
        }
        const insert = `[[${b.name}]]`;
        view.dispatch({ changes: { from: at, to: end, insert }, selection: { anchor: at + insert.length }, userEvent: "input.complete" });
      },
    }));
    if (!options.length) return null;
    return { from, options, filter: false }; // ranked already, in this order
  };
  return [
    autocompletion({ override: [source], icons: true, closeOnBlur: true, maxRenderedOptions: 40 }),
    // Above the canvas, at screen size, and never clipped by the block.
    tooltips({ parent: document.body }),
  ];
}
