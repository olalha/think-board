// Telling an HTML block's page which theme think is in.
//
// Inside a frame, `prefers-color-scheme` answers with the computer's setting,
// not think's own (System / Light / Dark). So the page is rewritten: its
// `(prefers-color-scheme: …)` queries — in CSS and in matchMedia() — always or
// never match, and its color-scheme is pinned. Pure: also unit-tested.

const SCHEME_QUERY = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi;

/** `source` as a page that believes the viewer prefers `theme`. */
export function withTheme(source: string, theme: "light" | "dark"): string {
  const dark = theme === "dark";
  const answer = (v: string) => ((v.toLowerCase() === "dark") === dark ? "(min-width: 0px)" : "(max-width: -1px)");
  const css = source.replace(SCHEME_QUERY, (_m, v: string) => answer(v));
  const shim =
    `<style>:root{color-scheme:${theme} !important}</style>` +
    `<script>(()=>{const m=window.matchMedia.bind(window),d=${dark};` +
    `window.matchMedia=(q)=>m(String(q).replace(/\\(\\s*prefers-color-scheme\\s*:\\s*(dark|light)\\s*\\)/gi,(_,v)=>(v.toLowerCase()==="dark")===d?"(min-width: 0px)":"(max-width: -1px)"));})();</script>`;
  // After <head> (or <html>, or the doctype) — never before the doctype, which would mean quirks mode.
  for (const re of [/<head[^>]*>/i, /<html[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(css);
    if (m) return css.slice(0, m.index + m[0].length) + shim + css.slice(m.index + m[0].length);
  }
  return shim + css;
}
