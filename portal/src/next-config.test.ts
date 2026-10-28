import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("Next development diagnostics", () => {
  it("disables Server Action argument logging without disabling request diagnostics", () => {
    expect(nextConfig.logging).toEqual({ serverFunctions: false });
  });
});
