import { describe, expect, it } from "vitest";
import { suppress } from "./api";

describe("suppress", () => {
  it("uses the configured minimum group size, lower or higher than the default", () => {
    expect(suppress(3, 3, "v", false)).toEqual({ suppressed: false, userCount: 3, value: "v" });
    expect(suppress(2, 3, "v", false).suppressed).toBe(true);
    expect(suppress(7, 8, "v", false).suppressed).toBe(true);
  });

  it("never goes below a group of 2", () => {
    expect(suppress(1, 1, "v", false).suppressed).toBe(true);
    expect(suppress(1, 0, "v", false).suppressed).toBe(true);
  });
});
