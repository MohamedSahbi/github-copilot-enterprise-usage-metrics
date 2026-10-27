import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  discoverLegacyMetricsCandidates,
  importLegacyMetricsRange,
  legacyRawBlobReportDay,
  parseLegacyMetricsImportArgs,
  type LegacyMetricsImportDependencies,
  type LegacyMetricsImportOptions,
} from "./legacy-metrics.js";

const baseOptions: LegacyMetricsImportOptions = {
  sourceAccountUrl: "https://legacy.blob.core.windows.net",
  sourceContainer: "usage-metrics-reports",
  archiveAccountUrl: "https://portal.blob.core.windows.net",
  archiveContainer: "metrics-raw",
  sqlServer: "portal.database.windows.net",
  sqlDatabase: "portal",
  managedIdentityClientId: "00000000-0000-4000-8000-000000000001",
  organizationId: 12345,
  organizationLogin: "example-org",
  fromDay: "2025-01-31",
  toDay: "2025-02-02",
  execute: false,
};

const legacyNames = [
  "2025/01/raw/UsageMetrics-31-01-2025.json",
  "2025/02/raw/UsageMetrics-01-02-2025.json",
  "2025/02/raw/UsageMetrics-02-02-2025.json",
];
const bytesByName = new Map(legacyNames.map((name) => [name, Buffer.from(`synthetic:${name}\n`)]));

function createDependencies(overrides: Partial<LegacyMetricsImportDependencies> = {}): LegacyMetricsImportDependencies {
  return {
    async *listBlobNames(prefix) {
      for (const name of legacyNames) if (name.startsWith(prefix)) yield name;
      if (prefix === "2025/01/raw/") yield "2025/01/enhanced/UsageMetricsEnhanced-31-01-2025.json";
    },
    async downloadBlob(name) {
      const bytes = bytesByName.get(name);
      if (!bytes) throw new Error(`unexpected blob ${name}`);
      return bytes;
    },
    async currentPublishedDigest() { return undefined; },
    async loadDay() {
      return {
        runId: "00000000-0000-4000-8000-000000000002",
        status: "published",
        rowsRead: 1,
        rowsLoaded: 1,
        rowsQuarantined: 0,
        issues: 0,
        artifactId: 1,
        blobPath: "raw/users_1_day/example-org/2025/01/31/example.ndjson",
      };
    },
    ...overrides,
  };
}

function digest(name: string): string {
  return createHash("sha256").update(bytesByName.get(name)!).digest("hex");
}

describe("legacy metrics importer", () => {
  it("recognizes only the verified raw legacy path and validates its date", () => {
    expect(legacyRawBlobReportDay("2025/01/raw/UsageMetrics-31-01-2025.json")).toBe("2025-01-31");
    expect(legacyRawBlobReportDay("2025/01/enhanced/UsageMetricsEnhanced-31-01-2025.json")).toBeUndefined();
    expect(() => legacyRawBlobReportDay("2025/02/raw/UsageMetrics-31-01-2025.json")).toThrow(/disagree/);
    expect(() => legacyRawBlobReportDay("2025/02/raw/UsageMetrics-31-02-2025.json")).toThrow(/invalid report date/);
    expect(() => legacyRawBlobReportDay("2025/02/raw/UsageMetrics-01-02-2025.csv")).toThrow(/Unsupported/);
  });

  it("discovers bounded raw blobs in ascending date order without enhanced files", async () => {
    const candidates = await discoverLegacyMetricsCandidates(
      "2025-01-31",
      "2025-02-01",
      createDependencies().listBlobNames,
    );
    expect(candidates).toEqual([
      { reportDay: "2025-01-31", blobName: legacyNames[0] },
      { reportDay: "2025-02-01", blobName: legacyNames[1] },
    ]);
  });

  it("uses four-digit years in raw month prefixes", async () => {
    const prefixes: string[] = [];
    await discoverLegacyMetricsCandidates("0001-01-01", "0001-01-01", async function* (prefix) {
      prefixes.push(prefix);
      yield "0001/01/raw/UsageMetrics-02-01-0001.json";
    });
    expect(prefixes).toEqual(["0001/01/raw/"]);
  });

  it("rejects malformed raw blobs instead of silently omitting a date", async () => {
    await expect(discoverLegacyMetricsCandidates("2025-01-31", "2025-01-31", async function* (prefix) {
      if (prefix === "2025/01/raw/") yield "2025/01/raw/not-a-metrics-file.json";
    })).rejects.toThrow(/Unsupported raw metrics blob name/);

    const duplicateListing = await discoverLegacyMetricsCandidates("2025-01-31", "2025-01-31", async function* (prefix) {
      if (prefix === "2025/01/raw/") {
        yield legacyNames[0]!;
        yield legacyNames[0]!;
      }
    });
    expect(duplicateListing).toEqual([{ reportDay: "2025-01-31", blobName: legacyNames[0] }]);
  });

  it("rejects invalid date ranges and runtime values", async () => {
    expect(() => parseLegacyMetricsImportArgs([
      "--source-account-url", baseOptions.sourceAccountUrl,
      "--source-container", baseOptions.sourceContainer,
      "--archive-account-url", baseOptions.archiveAccountUrl,
      "--archive-container", baseOptions.archiveContainer,
      "--sql-server", baseOptions.sqlServer,
      "--sql-database", baseOptions.sqlDatabase,
      "--managed-identity-client-id", baseOptions.managedIdentityClientId,
      "--organization-id", "12345",
      "--organization-login", "example-org",
      "--from", "2025-02-30",
      "--to", "2025-03-01",
    ])).toThrow(/real ISO calendar dates/);
    await expect(importLegacyMetricsRange(
      { ...baseOptions, fromDay: "2025-02-01", toDay: "2025-01-01" },
      createDependencies(),
    )).rejects.toThrow(/from date must not be after to date/);
    expect(() => parseLegacyMetricsImportArgs([
      "--source-account-url", "http://legacy.blob.core.windows.net",
      "--source-container", baseOptions.sourceContainer,
      "--archive-account-url", baseOptions.archiveAccountUrl,
      "--archive-container", baseOptions.archiveContainer,
      "--sql-server", baseOptions.sqlServer,
      "--sql-database", baseOptions.sqlDatabase,
      "--managed-identity-client-id", baseOptions.managedIdentityClientId,
      "--organization-id", "12345",
      "--organization-login", "example-org",
      "--from", "2025-01-31",
      "--to", "2025-02-01",
    ])).toThrow(/must use HTTPS/);
    await expect(importLegacyMetricsRange(
      {
        ...baseOptions,
        archiveAccountUrl: baseOptions.sourceAccountUrl,
        archiveContainer: baseOptions.sourceContainer,
      },
      createDependencies(),
    )).rejects.toThrow(/containers must be different/);
    expect(() => parseLegacyMetricsImportArgs([
      "--source-account-url", "https://attacker.example",
      "--source-container", baseOptions.sourceContainer,
      "--archive-account-url", baseOptions.archiveAccountUrl,
      "--archive-container", baseOptions.archiveContainer,
      "--sql-server", "attacker.example",
      "--sql-database", baseOptions.sqlDatabase,
      "--managed-identity-client-id", baseOptions.managedIdentityClientId,
      "--organization-id", "12345",
      "--organization-login", "example-org",
      "--from", "2025-01-31",
      "--to", "2025-02-01",
    ])).toThrow(/Azure Blob account origin/);
    expect(() => parseLegacyMetricsImportArgs([
      "--source-account-url", baseOptions.sourceAccountUrl,
      "--source-container", baseOptions.sourceContainer,
      "--archive-account-url", baseOptions.archiveAccountUrl,
      "--archive-container", baseOptions.archiveContainer,
      "--sql-server", "attacker.example",
      "--sql-database", baseOptions.sqlDatabase,
      "--managed-identity-client-id", baseOptions.managedIdentityClientId,
      "--organization-id", "12345",
      "--organization-login", "example-org",
      "--from", "2025-01-31",
      "--to", "2025-02-01",
    ])).toThrow(/Azure SQL server DNS name/);
  });

  it("dry-runs without calling the day loader and reports the digest", async () => {
    const loadDay = vi.fn();
    const outcomes = await importLegacyMetricsRange(baseOptions, createDependencies({ loadDay }));
    expect(outcomes.map(({ action }) => action)).toEqual(["would-import", "would-import", "would-import"]);
    expect(outcomes[0]?.sha256).toBe(digest(legacyNames[0]!));
    expect(loadDay).not.toHaveBeenCalled();
  });

  it("skips a day only when the current published archive digest matches", async () => {
    const loadDay = vi.fn(createDependencies().loadDay);
    const outcomes = await importLegacyMetricsRange(baseOptions, createDependencies({
      async currentPublishedDigest(reportDay) {
        return reportDay === "2025-01-31" ? digest(legacyNames[0]!) : undefined;
      },
      loadDay,
    }));
    expect(outcomes[0]?.action).toBe("skipped");
    expect(outcomes.slice(1).map(({ action }) => action)).toEqual(["would-import", "would-import"]);
    expect(loadDay).not.toHaveBeenCalled();
  });

  it("passes the exact raw bytes and day to the existing loader when executing", async () => {
    const loadDay = vi.fn(createDependencies().loadDay);
    const outcomes = await importLegacyMetricsRange({ ...baseOptions, execute: true }, createDependencies({ loadDay }));
    expect(outcomes.map(({ action }) => action)).toEqual(["published", "published", "published"]);
    expect(loadDay).toHaveBeenCalledTimes(3);
    expect(loadDay.mock.calls[0]?.[0]).toMatchObject({
      reportDay: "2025-01-31",
      organizationId: baseOptions.organizationId,
      organizationLogin: baseOptions.organizationLogin,
      content: bytesByName.get(legacyNames[0]!),
    });
  });

  it("surfaces source, digest-check, and quarantined-load errors", async () => {
    await expect(importLegacyMetricsRange(baseOptions, createDependencies({
      async downloadBlob() { throw new Error("source unavailable"); },
    }))).rejects.toThrow("source unavailable");
    await expect(importLegacyMetricsRange(baseOptions, createDependencies({
      async currentPublishedDigest() { throw new Error("SQL unavailable"); },
    }))).rejects.toThrow("SQL unavailable");
    await expect(importLegacyMetricsRange({ ...baseOptions, execute: true }, createDependencies({
      async loadDay(input) {
        return { ...await createDependencies().loadDay(input), status: "quarantined" };
      },
    }))).rejects.toThrow(/was quarantined/);
  });
});
