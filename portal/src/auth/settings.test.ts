import { describe, expect, it } from "vitest";
import { readMinGroupSize } from "./settings";

describe("readMinGroupSize", () => {
  it("defaults to 5 when MIN_GROUP_SIZE is unset", () => {
    expect(readMinGroupSize({})).toBe(5);
  });

  it("accepts a lower or higher whole number of at least 2", () => {
    expect(readMinGroupSize({ MIN_GROUP_SIZE: "2" })).toBe(2);
    expect(readMinGroupSize({ MIN_GROUP_SIZE: "10" })).toBe(10);
  });

  it.each(["", " ", "1", "0", "-3", "4.5", "five"])("rejects %j", (value) => {
    expect(() => readMinGroupSize({ MIN_GROUP_SIZE: value })).toThrow("MIN_GROUP_SIZE must be a whole number of at least 2");
  });
});
