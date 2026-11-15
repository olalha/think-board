// Fuzzy matching for pickers: the command palette and the @ picker in the editor.

/**
 * Subsequence match with bonuses for word starts and runs, like editor
 * "go to file". Returns null when `q` is not a subsequence of `text`.
 */
export function fuzzy(q: string, text: string): { score: number; hits: number[] } | null {
  if (!q) return { score: 0, hits: [] };
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  const hits: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of query) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, ti);
    if (at === -1) return null;
    const wordStart = at === 0 || /[\s\-_./]/.test(t[at - 1]);
    score += 1 + (wordStart ? 3 : 0) + (at === prev + 1 ? 2 : 0);
    hits.push(at);
    prev = at;
    ti = at + 1;
  }
  if (t.startsWith(query)) score += 6;
  score -= Math.min(4, (t.length - hits.length) / 20);
  return { score, hits };
}
