import { describe, expect, it } from "vitest";
import { assertTestAuthAllowed, isTestAuthEnabled, isTestPersonaId } from "./test-auth";

describe("assertTestAuthAllowed", () => {
  it("allows a normal production start without the flag", () => {
    expect(() => assertTestAuthAllowed({ NODE_ENV: "production" })).not.toThrow();
  });

  it("refuses the flag in production", () => {
    expect(() => assertTestAuthAllowed({ NODE_ENV: "production", E2E_TEST_AUTH: "1" })).toThrow(/production/);
  });

  it("allows the flag in development", () => {
    expect(() => assertTestAuthAllowed({ NODE_ENV: "development", E2E_TEST_AUTH: "1" })).not.toThrow();
  });

  it("refuses the flag in production even when marked as a local build", () => {
    expect(() =>
      assertTestAuthAllowed({ NODE_ENV: "production", E2E_TEST_AUTH: "1", E2E_LOCAL_BUILD: "1" }),
    ).toThrow(/production/);
  });
});

describe("test personas", () => {
  it("only enables with the exact flag value", () => {
    expect(isTestAuthEnabled({ E2E_TEST_AUTH: "true" })).toBe(false);
    expect(isTestAuthEnabled({ E2E_TEST_AUTH: "1" })).toBe(true);
  });

  it("rejects prototype keys and unknown personas", () => {
    expect(isTestPersonaId("toString")).toBe(false);
    expect(isTestPersonaId("root")).toBe(false);
    expect(isTestPersonaId("admin")).toBe(true);
  });

  it("refuses even checking test auth when production is misconfigured", () => {
    expect(() => isTestAuthEnabled({ NODE_ENV: "production", E2E_TEST_AUTH: "1" })).toThrow(/production/);
  });
});
