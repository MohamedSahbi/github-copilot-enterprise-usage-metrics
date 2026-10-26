import { describe, expect, it } from "vitest";
import {
  DecimalOverflowError,
  averageDecimal,
  exactDecimal18_9,
  exactDecimal38_9,
  percentageDecimal,
} from "./decimal";

describe("exact DECIMAL(38,9) arithmetic", () => {
  it("keeps source-row DECIMAL(18,9) limits separate from aggregate limits", () => {
    expect(exactDecimal18_9("999999999.999999999")).toBe("999999999.999999999");
    expect(exactDecimal18_9("1000000000")).toBeNull();
    expect(exactDecimal18_9("0.0000000001")).toBeNull();
    expect(exactDecimal38_9("1999999999.999999998")).toBe("1999999999.999999998");
  });

  it("accepts the full aggregate integer range without applying the source-row bound", () => {
    expect(exactDecimal38_9("1999999999.999999998")).toBe("1999999999.999999998");
    expect(exactDecimal38_9("99999999999999999999999999999.999999999"))
      .toBe("99999999999999999999999999999.999999999");
    expect(exactDecimal38_9("1000000000")).toBe("1000000000");
  });

  it("rejects values outside DECIMAL(38,9) or requiring rounding", () => {
    expect(exactDecimal38_9("100000000000000000000000000000")).toBeNull();
    expect(exactDecimal38_9("0.0000000001")).toBeNull();
    expect(exactDecimal38_9("not-a-decimal")).toBeNull();
  });

  it("computes repeating averages and percentages with exact intermediates", () => {
    expect(averageDecimal("1", 3)).toBe("0.333333333");
    expect(averageDecimal("0.000000001", 2)).toBe("0.000000001");
    expect(percentageDecimal("1", "3")).toBe("33.333333333");
    expect(percentageDecimal("2", "3")).toBe("66.666666667");
  });

  it("returns null for zero denominators and rejects invalid counts", () => {
    expect(averageDecimal("42.5", 0)).toBeNull();
    expect(percentageDecimal("42.5", "0")).toBeNull();
    expect(() => averageDecimal("1", -1)).toThrow(RangeError);
    expect(() => averageDecimal("1", 1.5)).toThrow(RangeError);
  });

  it("throws a typed overflow instead of returning a partial decimal", () => {
    expect(() => percentageDecimal("99999999999999999999999999999.999999999", "0.000000001"))
      .toThrow(DecimalOverflowError);
    expect(() => averageDecimal("100000000000000000000000000000", 1))
      .toThrow(DecimalOverflowError);
  });
});
