// The block name editor's preview of a rename (it mirrors the server's rules).
import { describe, expect, it } from "vitest";
import { renamePreview } from "../src/client/lib/naming.js";

const none = new Set<string>();

describe("rename preview", () => {
  it("keeps free text as the title and makes the file name from it", () => {
    expect(renamePreview("Tea & biscuits 🍪", "notes", undefined, none)).toEqual({ name: "tea-biscuits", title: "Tea & biscuits 🍪" });
  });
  it("a plain name renames the file and clears the title", () => {
    expect(renamePreview("tea-guide", "notes", "Notes!", none)).toEqual({ name: "tea-guide" });
  });
  it("text that reads as the name is no title", () => {
    expect(renamePreview("Tea guide", "notes", undefined, none)).toEqual({ name: "tea-guide" });
  });
  it("a title whose name is the current one changes only the title", () => {
    expect(renamePreview("Notes!", "notes", undefined, none)).toEqual({ name: "notes", title: "Notes!" });
    expect(renamePreview("🍵", "notes", undefined, none)).toEqual({ name: "notes", title: "🍵" });
  });
  it("is null when nothing changes or nothing is typed", () => {
    expect(renamePreview("Notes", "notes", undefined, none)).toBeNull();
    expect(renamePreview("  Notes!  ", "notes", "Notes!", none)).toBeNull();
    expect(renamePreview("   ", "notes", undefined, none)).toBeNull();
  });
  it("numbers a taken name for free text, refuses it as a plain name", () => {
    const taken = new Set(["tea", "tea-2"]);
    expect(renamePreview("Tea", "notes", undefined, taken)).toEqual({ name: "tea-3", title: "Tea" });
    expect(renamePreview("tea", "notes", undefined, taken)?.error).toMatch(/exists/);
  });
});
