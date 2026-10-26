import { describe, expect, it } from "vitest";
import { formatUserCredits } from "./userCredits";

describe("user-table credit formatting", () => {
  it("converts the exact wire string only for one-fractional-digit display", () => {
    expect(formatUserCredits("1234.56")).toBe("1,234.6");
    expect(formatUserCredits("1999999999.999999998")).toBe("2,000,000,000");
  });
});
