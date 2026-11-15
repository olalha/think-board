// The Files tab's CSV preview parser.
import { describe, expect, it } from "vitest";
import { guessDelimiter, parseDelimited } from "../src/client/lib/csv.js";

describe("CSV preview", () => {
  it("parses quoted fields, doubled quotes, embedded delimiters and newlines", () => {
    expect(parseDelimited('name,note\r\n"Smith, J","said ""hi""\nthen left"\nlast,\n', ",")).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
      ["last", ""],
    ]);
    expect(parseDelimited("a\tb\n1\t2", "\t")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("guesses the delimiter", () => {
    expect(guessDelimiter("x.tsv", "a,b")).toBe("\t");
    expect(guessDelimiter("x.csv", "a;b;c")).toBe(";");
    expect(guessDelimiter("x.csv", "a,b;c,d")).toBe(",");
  });
});
