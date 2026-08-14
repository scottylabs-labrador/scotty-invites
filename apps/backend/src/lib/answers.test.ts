import { describe, expect, it } from "vitest";
import { answerText } from "./answers";

describe("answerText", () => {
  it("passes a plain string through untouched, spaces and all", () => {
    expect(answerText("Vegetarian")).toBe("Vegetarian");
    expect(answerText("  S  ")).toBe("  S  ");
  });

  it("renders a phone number that lost its string-ness in the jsonb round-trip", () => {
    // A stored "4125551234" is decoded twice and comes back as a number.
    expect(answerText(4125551234)).toBe("4125551234");
  });

  it("renders booleans instead of blanking them", () => {
    expect(answerText(true)).toBe("true");
    expect(answerText(false)).toBe("false");
  });

  it("renders a stored \"null\" as an empty cell", () => {
    expect(answerText(null)).toBe("");
    expect(answerText(undefined)).toBe("");
  });

  it("never emits [object Object]", () => {
    expect(answerText({ a: 1 })).toBe('{"a":1}');
  });

  it("joins arrays the way the dietary column already does", () => {
    expect(answerText(["Vegan", "Halal"])).toBe("Vegan; Halal");
  });

  it("renders zero and the empty string faithfully", () => {
    expect(answerText(0)).toBe("0");
    expect(answerText("")).toBe("");
  });
});
