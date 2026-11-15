// `[[links]]` in rendered Markdown: the remark plugin and the chips MarkdownView draws.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { splitBlockLinks, type MdNode } from "../src/client/blocks/block-links.js";
import { MarkdownView } from "../src/client/blocks/renderers.js";

const text = (value: string): MdNode => ({ type: "text", value });

describe("splitBlockLinks", () => {
  it("splits text around links, keeping the shown text", () => {
    const p: MdNode = { type: "paragraph", children: [text("See [[tea-notes]] and [[cake|the cake]].")] };
    splitBlockLinks(p);
    expect(p.children!.map((c) => (c.type === "text" ? c.value : `<${c.data?.hProperties?.dataBlock}|${c.data?.hProperties?.dataText ?? ""}>`))).toEqual([
      "See ",
      "<tea-notes|>",
      " and ",
      "<cake|the cake>",
      ".",
    ]);
  });
  it("leaves code, links and text without links alone", () => {
    const code: MdNode = { type: "inlineCode", value: "[[a]]" };
    const link: MdNode = { type: "link", children: [text("[[b]]")] };
    const plain = text("no links [here]");
    const p: MdNode = { type: "paragraph", children: [code, link, plain] };
    splitBlockLinks(p);
    expect(p.children).toEqual([code, link, plain]);
  });
  it("reaches into nested nodes", () => {
    const em: MdNode = { type: "emphasis", children: [text("[[deep]]")] };
    splitBlockLinks({ type: "root", children: [{ type: "list", children: [{ type: "listItem", children: [em] }] }] });
    expect(em.children![0].type).toBe("blockLink");
  });
});

describe("MarkdownView block links", () => {
  const render = (source: string, props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(MarkdownView, { source, ...props }));
  const resolveLink = (name: string) => (name === "tea" ? { label: "Tea ☕", exists: true } : { label: name, exists: false });

  it("draws chips with the label, or the shown text", () => {
    const html = render("[[tea]] and [[tea|my tea]]", { resolveLink, onLinkClick: () => {} });
    expect(html).toContain('data-block="tea"');
    expect(html).toContain(">@Tea ☕</button>");
    expect(html).toContain(">my tea</button>");
  });
  it("marks a link to a missing block", () => {
    const html = render("[[gone]]", { resolveLink });
    expect(html).toMatch(/class="block-link missing"[^>]*data-tip="No block named “gone”"/);
  });
  it("keeps links in code as text", () => {
    const html = render("`[[tea]]`\n\n```\n[[tea]]\n```\n", { resolveLink });
    expect(html).not.toContain("data-block");
    expect(html).toContain("[[tea]]");
  });
  it("reads the name made readable without a resolver", () => {
    expect(render("[[tea-notes]]")).toContain('<span class="block-link" data-block="tea-notes">@Tea notes</span>');
  });
});
