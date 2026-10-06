import { describe, expect, it } from "vitest";
import { quoteInText } from "../src/text/quote.ts";
import { tokenJaccard, tokens } from "../src/text/similarity.ts";

describe("tokenJaccard", () => {
  it("compares token sets case- and punctuation-insensitively", () => {
    expect(tokens("Send the deck, by Friday!")).toEqual(["send", "the", "deck", "by", "friday"]);
    expect(tokenJaccard("Send the deck", "send THE deck.")).toBe(1);
    expect(tokenJaccard("a b c d", "a b x y")).toBeCloseTo(2 / 6);
    expect(tokenJaccard("", "")).toBe(1);
    expect(tokenJaccard("a", "")).toBe(0);
  });
});

describe("quoteInText", () => {
  const seg = "Okay, so I’ll send the revised budget to Priya by Friday.";
  it("matches verbatim quotes, ignoring case, curly quotes and edge punctuation", () => {
    expect(quoteInText("I'll send the revised budget to Priya by Friday.", seg)).toBe(true);
    expect(quoteInText('"send the revised budget"', seg)).toBe(true);
  });
  it("rejects paraphrases, trivial and overlong quotes", () => {
    expect(quoteInText("I will send the budget to Priya", seg)).toBe(false);
    expect(quoteInText("ok", seg)).toBe(false);
    const long = Array.from({ length: 61 }, (_, i) => `w${i}`).join(" ");
    expect(quoteInText(long, long)).toBe(false);
  });
});
