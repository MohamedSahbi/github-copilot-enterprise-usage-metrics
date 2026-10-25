import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  attributeEmptyShareExceeded,
  normalizeDirectoryValue,
  validateSettings,
} from "./settings";

describe("deployment settings (items 6, 8, 11)", () => {
  it("has the agreed defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      retention: { perUserMonths: 13, loginHistoryMonths: 24 },
      privacy: { minGroupSize: 5 },
      access: { breakGlassGroupId: "", permissionFreshnessMinutes: 5 },
      directory: { departmentAttribute: "", businessAreaAttribute: "", emptyAttributeThresholdPercent: 20 },
    });
  });

  it("accepts an empty input and returns the defaults", () => {
    expect(validateSettings({})).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
  });

  it("accepts commented-example values", () => {
    const r = validateSettings({
      access: { breakGlassGroupId: "00000000-0000-0000-0000-000000000000", permissionFreshnessMinutes: 1 },
      directory: { departmentAttribute: "department", businessAreaAttribute: "onPremisesExtensionAttributes.extensionAttribute1" },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a freshness below 1 minute or not an integer", () => {
    for (const v of [0, -5, 1.5, Number.NaN, "5"]) {
      const r = validateSettings({ access: { permissionFreshnessMinutes: v } });
      expect(r.ok, String(v)).toBe(false);
    }
  });

  it("rejects a break-glass group ID that is not a GUID", () => {
    const r = validateSettings({ access: { breakGlassGroupId: "admins" } });
    expect(r).toMatchObject({ ok: false });
  });

  it("rejects a minimum group size below 5, for every scope", () => {
    expect(validateSettings({ privacy: { minGroupSize: 4 } }).ok).toBe(false);
    expect(validateSettings({ privacy: { minGroupSize: 5 } }).ok).toBe(true);
  });

  it("rejects an attribute name with unsafe characters", () => {
    expect(validateSettings({ directory: { departmentAttribute: "dept; drop" } }).ok).toBe(false);
  });

  it("requires a login history age of at least 1 month", () => {
    expect(validateSettings({ retention: { loginHistoryMonths: 0 } }).ok).toBe(false);
    expect(validateSettings({ retention: { loginHistoryMonths: 36 } }).ok).toBe(true);
  });

  it("bounds the empty-attribute threshold to 1..100 percent", () => {
    expect(validateSettings({ directory: { emptyAttributeThresholdPercent: 0 } }).ok).toBe(false);
    expect(validateSettings({ directory: { emptyAttributeThresholdPercent: 101 } }).ok).toBe(false);
    expect(validateSettings({ directory: { emptyAttributeThresholdPercent: 50 } }).ok).toBe(true);
  });
});

describe("directory value normalization (item 6)", () => {
  it("trims, collapses inner whitespace and lowercases", () => {
    expect(normalizeDirectoryValue("  Sales   EMEA ")).toBe("sales emea");
  });
  it("returns an empty string for null, undefined and blank values", () => {
    expect(normalizeDirectoryValue(null)).toBe("");
    expect(normalizeDirectoryValue(undefined)).toBe("");
    expect(normalizeDirectoryValue("   ")).toBe("");
  });
});

describe("attributeEmptyShareExceeded (item 6)", () => {
  it("is false when the attribute is disabled", () => {
    expect(attributeEmptyShareExceeded({ enabled: false, totalUsers: 100, emptyUsers: 100, thresholdPercent: 20 })).toBe(false);
  });
  it("is true only when the empty share is strictly above the threshold", () => {
    expect(attributeEmptyShareExceeded({ enabled: true, totalUsers: 100, emptyUsers: 20, thresholdPercent: 20 })).toBe(false);
    expect(attributeEmptyShareExceeded({ enabled: true, totalUsers: 100, emptyUsers: 21, thresholdPercent: 20 })).toBe(true);
  });
  it("is false for an empty directory", () => {
    expect(attributeEmptyShareExceeded({ enabled: true, totalUsers: 0, emptyUsers: 0, thresholdPercent: 20 })).toBe(false);
  });
});
