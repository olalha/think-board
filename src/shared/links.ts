// Links between blocks, written inside Markdown blocks as `[[block-name]]` or
// `[[block-name|text shown]]`. The target is the block's name (its file name
// without the extension), never its title, so a link survives retitling; when
// a block's file is renamed, think rewrites the links to it (rewriteBlockLinks).
// Links inside code — fenced blocks and inline code spans — are text, not links.

export interface BlockLink {
  /** The name linked to, trimmed (`tea-notes`). */
  target: string;
  /** The text after `|`, as written (undefined when there is none). */
  text?: string;
  /** Where the whole `[[…]]` starts and ends in the source. */
  start: number;
  end: number;
}

const LINK_RE = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]*))?\]\]/g;
const FENCE_OPEN_RE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})(.*)$/;

/** The parts of a Markdown text that are code: [start, end) offsets, in order. */
export function codeRanges(md: string): [number, number][] {
  const ranges: [number, number][] = [];
  let fence: { char: string; len: number; start: number } | null = null;
  let proseStart = 0;
  let pos = 0;
  const prose = (from: number, to: number) => {
    if (to > from) ranges.push(...inlineCode(md, from, to));
  };
  while (pos <= md.length) {
    const nl = md.indexOf("\n", pos);
    const lineEnd = nl === -1 ? md.length : nl;
    const line = md.slice(pos, lineEnd);
    if (fence) {
      const close = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        ranges.push([fence.start, lineEnd]);
        fence = null;
        proseStart = lineEnd;
      }
    } else {
      const open = FENCE_OPEN_RE.exec(line);
      if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
        prose(proseStart, pos);
        fence = { char: open[1][0], len: open[1].length, start: pos };
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (fence) ranges.push([fence.start, md.length]); // an unclosed fence runs to the end
  else prose(proseStart, md.length);
  return ranges;
}

/** Inline code spans in md[from, to): a run of n backticks up to the next run of exactly n. */
function inlineCode(md: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let i = from;
  while (i < to) {
    if (md[i] === "\\") {
      i += 2;
      continue;
    }
    if (md[i] !== "`") {
      i++;
      continue;
    }
    let n = 0;
    while (i + n < to && md[i + n] === "`") n++;
    let j = i + n;
    let closed = -1;
    while (j < to) {
      if (md[j] !== "`") {
        j++;
        continue;
      }
      let m = 0;
      while (j + m < to && md[j + m] === "`") m++;
      if (m === n) {
        closed = j + m;
        break;
      }
      j += m;
    }
    if (closed === -1) {
      i += n; // no matching run: the backticks are literal
      continue;
    }
    out.push([i, closed]);
    i = closed;
  }
  return out;
}

/** Every `[[…]]` link in a Markdown text, outside code. */
export function findBlockLinks(md: string): BlockLink[] {
  const code = codeRanges(md);
  const inCode = (at: number) => code.some(([s, e]) => at >= s && at < e);
  return linksInText(md).filter((l) => !inCode(l.start));
}

/**
 * Every `[[…]]` link in a plain run of text, code or not — for text already
 * known to be prose (a text node of parsed Markdown).
 */
export function linksInText(text: string): BlockLink[] {
  const links: BlockLink[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const target = m[1].trim();
    if (!target) continue;
    links.push({ target, ...(m[2] !== undefined ? { text: m[2] } : {}), start: m.index, end: m.index + m[0].length });
  }
  return links;
}

/**
 * Point the links at renamed blocks to their new names: each `[[from]]` or
 * `[[from|text]]` becomes `[[to]]` / `[[to|text]]`, outside code. Renames are
 * applied in order, so a → b then b → c leaves `[[c]]`. Returns the text
 * unchanged (the same string) when no link matched.
 */
export function rewriteBlockLinks(md: string, renames: readonly (readonly [from: string, to: string])[]): string {
  let out = md;
  for (const [from, to] of renames) {
    if (from === to || !out.includes("[[")) continue;
    const links = findBlockLinks(out).filter((l) => l.target === from);
    if (!links.length) continue;
    let next = "";
    let at = 0;
    for (const l of links) {
      next += out.slice(at, l.start) + `[[${to}${l.text !== undefined ? `|${l.text}` : ""}]]`;
      at = l.end;
    }
    out = next + out.slice(at);
  }
  return out;
}
