import { describe, expect, it } from "vitest";
import { validateMetricsRuntimeSettings } from "./metrics-runtime-settings";

const validSettings = {
  githubAppId: "123456",
  organizations: ["example-org", "Example-Team"],
  sqlServer: "sql-example.database.windows.net",
  sqlDatabase: "portal",
  managedIdentityClientId: "00000000-0000-0000-0000-000000000001",
  rawArchiveAccount: "storageaccount1",
  rawArchiveContainer: "raw",
};

describe("metrics runtime settings", () => {
  it("accepts the required settings and omits optional backfill by default", () => {
    expect(validateMetricsRuntimeSettings(validSettings, "2026-10-25")).toEqual({
      ok: true,
      settings: {
        ...validSettings,
        organizations: ["example-org", "Example-Team"],
      },
    });
  });

  it("accepts a supplied date only inside the canonical API-start and rolling history window", () => {
    expect(validateMetricsRuntimeSettings({ ...validSettings, backfillFrom: "2025-10-25" }, "2026-10-25").ok).toBe(true);
    expect(validateMetricsRuntimeSettings({ ...validSettings, backfillFrom: "2026-10-25" }, "2026-10-25").ok).toBe(true);
    expect(validateMetricsRuntimeSettings({ ...validSettings, backfillFrom: "2025-10-10" }, "2025-11-01").ok).toBe(true);
    expect(validateMetricsRuntimeSettings({ ...validSettings, backfillFrom: "2027-03-01" }, "2028-02-29").ok).toBe(true);
  });

  it("rejects supplied empty, malformed, future, API-prestart, and expired dates", () => {
    for (const backfillFrom of ["", "2026-02-30", "2026-1-01", "2026-10-26", "2025-10-09", "2027-02-28"]) {
      expect(validateMetricsRuntimeSettings({ ...validSettings, backfillFrom }, "2026-10-25").ok, backfillFrom).toBe(false);
    }
    expect(validateMetricsRuntimeSettings({ ...validSettings, backfillFrom: "2025-10-09" }, "2025-11-01").ok).toBe(false);
  });

  it("requires every nonsecret field and rejects invalid identifiers and storage names", () => {
    for (const [field, value] of [
      ["githubAppId", "0"],
      ["githubAppId", "-2"],
      ["githubAppId", "12.5"],
      ["organizations", []],
      ["organizations", ["bad--login"]],
      ["sqlServer", "https://sql.example"],
      ["sqlDatabase", "bad/name"],
      ["sqlDatabase", " "],
      ["managedIdentityClientId", "not-a-guid"],
      ["rawArchiveAccount", "UPPERCASE"],
      ["rawArchiveAccount", "ab"],
      ["rawArchiveContainer", "ab"],
      ["rawArchiveContainer", "bad--container"],
    ] as const) {
      expect(validateMetricsRuntimeSettings({ ...validSettings, [field]: value }).ok, field).toBe(false);
    }

    for (const setting of Object.keys(validSettings)) {
      const incomplete: Record<string, unknown> = { ...validSettings };
      delete incomplete[setting];
      expect(validateMetricsRuntimeSettings(incomplete).ok, setting).toBe(false);
    }
  });

  it("accepts exact identifier and storage-name boundaries", () => {
    expect(validateMetricsRuntimeSettings({
      ...validSettings,
      githubAppId: "1",
      organizations: ["a"],
      sqlServer: `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
      sqlDatabase: "d".repeat(128),
      rawArchiveAccount: "a".repeat(24),
      rawArchiveContainer: `a${"b".repeat(61)}c`,
    }).ok).toBe(true);
    expect(validateMetricsRuntimeSettings({ ...validSettings, organizations: ["a".repeat(40)] }).ok).toBe(false);
    expect(validateMetricsRuntimeSettings({ ...validSettings, sqlDatabase: "d".repeat(129) }).ok).toBe(false);
    expect(validateMetricsRuntimeSettings({ ...validSettings, rawArchiveAccount: "a".repeat(25) }).ok).toBe(false);
    expect(validateMetricsRuntimeSettings({ ...validSettings, rawArchiveContainer: `a${"b".repeat(62)}c` }).ok).toBe(false);
  });

  it("rejects organization identities that differ only by case without changing their spelling", () => {
    const result = validateMetricsRuntimeSettings({
      ...validSettings,
      organizations: ["Example-Org", "example-org"],
    });
    expect(result).toMatchObject({
      ok: false,
      errors: [{ setting: "organizations.1", issue: "duplicates a GitHub organization identity" }],
    });
  });

  it("reports validation failures without echoing supplied values or unknown keys", () => {
    const privateMarker = "do-not-echo-private-source-value";
    const result = validateMetricsRuntimeSettings({
      ...validSettings,
      githubAppId: privateMarker,
      token: privateMarker,
    });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    expect(JSON.stringify(result)).not.toContain("token");
  });
});
