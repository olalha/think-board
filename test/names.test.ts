import { describe, expect, it } from "vitest";
import { allocateName } from "../src/server/names.js";
import { displayName, isValidName, parseBlockFile, toBlockName } from "../src/shared/blocks.js";

const POOL = ["harry", "bob", "tom"];

describe("allocateName", () => {
  it("takes the first unused name, in pool order", () => {
    expect(allocateName(POOL, new Set())).toBe("harry");
    expect(allocateName(POOL, new Set(["harry"]))).toBe("bob");
    expect(allocateName(POOL, new Set(["harry", "bob"]))).toBe("tom");
  });

  it("reuses a freed name before any suffixed one", () => {
    expect(allocateName(POOL, new Set(["bob", "tom", "harry-2"]))).toBe("harry");
  });

  it("cycles with suffixes once the pool is exhausted", () => {
    const all = new Set(POOL);
    expect(allocateName(POOL, all)).toBe("harry-2");
    all.add("harry-2");
    expect(allocateName(POOL, all)).toBe("bob-2");
    all.add("bob-2").add("tom-2");
    expect(allocateName(POOL, all)).toBe("harry-3");
  });

  it("ignores invalid and duplicate pool entries, and never runs dry", () => {
    expect(allocateName(["Bad Name", "ok", "ok"], new Set(["ok"]))).toBe("ok-2");
    expect(allocateName([], new Set())).toBe("block");
  });

  it("treats names as unique across extensions (callers pass every stem)", () => {
    // harry.png exists → "harry" is taken even though there is no harry.md
    expect(allocateName(POOL, new Set(["harry"]))).toBe("bob");
  });
});

describe("block names", () => {
  it("parses block files by extension and rejects the rest", () => {
    expect(parseBlockFile("harry.md")).toEqual({ name: "harry", ext: "md", type: "markdown" });
    expect(parseBlockFile("bob.mmd")?.type).toBe("mermaid");
    expect(parseBlockFile("sally-2.jpeg")?.type).toBe("image");
    expect(parseBlockFile("CLAUDE.md")).toBeNull();
    expect(parseBlockFile("notes.txt")).toBeNull();
    expect(parseBlockFile("canvas.json")).toBeNull();
    expect(parseBlockFile("-bad.md")).toBeNull();
  });

  it("validates and displays names", () => {
    expect(isValidName("harry-2")).toBe(true);
    expect(isValidName("Harry")).toBe(false);
    expect(isValidName("a--b")).toBe(false);
    expect(displayName("harry-2")).toBe("Harry 2");
    expect(displayName("tea-flowchart")).toBe("Tea flowchart");
    expect(displayName("cli-test-note")).toBe("CLI test note");
    expect(displayName("the-api-and-ios-app")).toBe("The API and iOS app");
    expect(displayName("idea-board")).toBe("Idea board"); // only whole words
    expect(toBlockName("  Tea Flowchart! ")).toBe("tea-flowchart");
    expect(toBlockName("Crème brûlée")).toBe("creme-brulee");
    expect(toBlockName("!!!")).toBe("");
  });
});
