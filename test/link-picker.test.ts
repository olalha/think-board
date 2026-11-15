// The @ picker in the Markdown editor: what opens it and how blocks rank.
import { describe, expect, it } from "vitest";
import { linkTrigger, rankBlocks, type PickerBlock } from "../src/client/blocks/link-picker.js";

describe("linkTrigger", () => {
  it("opens on @ at a word start and on [[", () => {
    expect(linkTrigger("@")).toEqual({ kind: "at", query: "", length: 1 });
    expect(linkTrigger("see @tea")).toEqual({ kind: "at", query: "tea", length: 4 });
    expect(linkTrigger("(@tea")).toEqual({ kind: "at", query: "tea", length: 4 });
    expect(linkTrigger("see [[")).toEqual({ kind: "brackets", query: "", length: 2 });
    expect(linkTrigger("see [[tea no")).toEqual({ kind: "brackets", query: "tea no", length: 8 });
  });
  it("stays shut mid-word, after a space in an @ query, and past a finished link", () => {
    expect(linkTrigger("me@example")).toBeNull();
    expect(linkTrigger("@tea notes")).toBeNull();
    expect(linkTrigger("[[tea]] and")).toBeNull();
    expect(linkTrigger("[[tea|text")).toBeNull();
    expect(linkTrigger("[[[tea")).toBeNull();
    expect(linkTrigger("plain text")).toBeNull();
  });
});

describe("rankBlocks", () => {
  const blocks: PickerBlock[] = [
    { name: "tea-notes", label: "Tea notes", type: "markdown" },
    { name: "cake", label: "Cake 🍰 & co", type: "image" },
    { name: "flow", label: "Brewing flow", type: "mermaid" },
  ];
  it("lists every block by label for an empty query", () => {
    expect(rankBlocks("", blocks).map((b) => b.name)).toEqual(["flow", "cake", "tea-notes"]);
  });
  it("matches labels and names fuzzily, best first", () => {
    expect(rankBlocks("tn", blocks)[0].name).toBe("tea-notes");
    expect(rankBlocks("brew", blocks).map((b) => b.name)).toEqual(["flow"]);
    expect(rankBlocks("flow", blocks)[0].name).toBe("flow");
    expect(rankBlocks("zzz", blocks)).toEqual([]);
  });
});
