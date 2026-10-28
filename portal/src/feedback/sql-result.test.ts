import { describe, expect, it } from "vitest";
import { requireFirstSqlRow, requireSqlResultSet } from "./sql-result";

describe("requireFirstSqlRow", () => {
  it("returns the first row when present", () => {
    expect(requireFirstSqlRow([{ id: 1 }], "Feedback query")).toEqual({ id: 1 });
  });

  it.each([{ rows: undefined }, { rows: [] }])("rejects a missing row result", ({ rows }) => {
    expect(() => requireFirstSqlRow(rows, "Feedback query"))
      .toThrow("Feedback query query returned no result row");
  });
});

describe("requireSqlResultSet", () => {
  it("allows an empty result set", () => {
    expect(requireSqlResultSet([], "Feedback item")).toEqual([]);
  });

  it("rejects a missing result set", () => {
    expect(() => requireSqlResultSet(undefined, "Feedback item"))
      .toThrow("Feedback item query returned no result set");
  });
});
