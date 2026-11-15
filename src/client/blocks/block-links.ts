// `[[block-name]]` and `[[block-name|text]]` links in rendered Markdown.
//
// A remark plugin: parsed Markdown keeps code (fenced blocks, inline spans) in
// nodes of its own, so splitting only text nodes leaves links in code as text,
// as the server's rewriting does. Each link becomes a `<span data-block>`
// element that MarkdownView draws as a chip. Raw HTML is never rendered there,
// so only a link can make one.

import { linksInText } from "../../shared/links";

/** The mdast shape this plugin reads and writes (a subset). */
export interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** Nodes whose text is not prose to link from: links already link somewhere. */
const SKIP = new Set(["link", "linkReference", "code", "inlineCode", "html", "definition"]);

/** The element a block link becomes: `<span class="block-link" data-block="name" [data-text]>text</span>`. */
export function blockLinkNode(target: string, text?: string): MdNode {
  return {
    type: "blockLink",
    data: {
      hName: "span",
      hProperties: { className: ["block-link"], dataBlock: target, ...(text !== undefined ? { dataText: text } : {}) },
    },
    children: [{ type: "text", value: text ?? target }],
  };
}

/** Split the text nodes under `node` around block links, in place. */
export function splitBlockLinks(node: MdNode): void {
  if (!node.children || SKIP.has(node.type)) return;
  const out: MdNode[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.type !== "text" || !child.value?.includes("[[")) {
      splitBlockLinks(child);
      out.push(child);
      continue;
    }
    const value = child.value;
    const links = linksInText(value);
    if (!links.length) {
      out.push(child);
      continue;
    }
    changed = true;
    let at = 0;
    for (const l of links) {
      if (l.start > at) out.push({ type: "text", value: value.slice(at, l.start) });
      out.push(blockLinkNode(l.target, l.text));
      at = l.end;
    }
    if (at < value.length) out.push({ type: "text", value: value.slice(at) });
  }
  if (changed) node.children = out;
}

/** The remark plugin: `remarkPlugins={[remarkGfm, remarkBlockLinks]}`. */
export function remarkBlockLinks() {
  return (tree: MdNode) => splitBlockLinks(tree);
}
