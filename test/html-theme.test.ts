import { describe, expect, it } from "vitest";
import { withTheme } from "../src/client/blocks/html-theme.js";

describe("HTML blocks follow think's theme", () => {
  const page = `<!doctype html><html><head><style>:root{--bg:#fff}@media (prefers-color-scheme: dark){:root{--bg:#111}}@media (prefers-color-scheme:light) and (min-width: 400px){p{}}</style></head><body></body></html>`;

  it("makes dark queries match in dark and never in light (and the reverse)", () => {
    const dark = withTheme(page, "dark");
    expect(dark).toContain("@media (min-width: 0px){:root{--bg:#111}}");
    expect(dark).toContain("@media (max-width: -1px) and (min-width: 400px)");
    const light = withTheme(page, "light");
    expect(light).toContain("@media (max-width: -1px){:root{--bg:#111}}");
    expect(light).toContain("@media (min-width: 0px) and (min-width: 400px)");
  });

  it("puts its shim after <head>, never before the doctype", () => {
    const out = withTheme(page, "light");
    expect(out.startsWith("<!doctype html><html><head><style>:root{color-scheme:light !important}</style><script>")).toBe(true);
    expect(withTheme("<p>bare</p>", "dark").startsWith("<style>:root{color-scheme:dark !important}")).toBe(true);
    expect(withTheme("<!DOCTYPE html><p>x</p>", "dark")).toMatch(/^<!DOCTYPE html><style>/);
  });

  it("rewrites matchMedia queries in the page's scripts too", () => {
    const shim = /<script>(.*?)<\/script>/.exec(withTheme(page, "dark"))![1];
    const calls: string[] = [];
    const win = { matchMedia: (q: string) => (calls.push(q), { matches: true }) };
    new Function("window", shim)(win);
    win.matchMedia("(prefers-color-scheme: dark)");
    win.matchMedia("(prefers-color-scheme: light)");
    win.matchMedia("(min-width: 600px)");
    expect(calls).toEqual(["(min-width: 0px)", "(max-width: -1px)", "(min-width: 600px)"]);
  });
});
