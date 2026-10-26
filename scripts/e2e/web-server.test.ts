import { describe, expect, it } from "vitest";
import { e2eWebServerCommand } from "./web-server";

describe("E2E web server", () => {
  it("keeps Turbopack as the default development server", () => {
    expect(e2eWebServerCommand(3100)).toBe("npm run dev -w portal -- --port 3100");
  });

  it("selects the isolated Webpack development server when configured", () => {
    expect(e2eWebServerCommand(3101, "webpack")).toBe("npm run dev:e2e -w portal -- --port 3101");
  });

  it("rejects unsupported development server selections", () => {
    expect(() => e2eWebServerCommand(3101, "other")).toThrow("E2E_DEV_BUNDLER");
  });
});
