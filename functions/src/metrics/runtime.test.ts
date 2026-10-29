import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MetricsBackfillDependencies } from "./backfill.js";
import { createMetricsRuntimeHandler, readMetricsRuntimeConfig } from "./runtime.js";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs8", format: "pem" }).toString();
const env = {
  GITHUB_APP_ID: "17", GITHUB_APP_PRIVATE_KEY: key, ORGANIZATIONS: "fixture-org",
  SQL_SERVER: "fixture.database.windows.net", SQL_DATABASE: "fixture",
  AZURE_CLIENT_ID: "00000000-0000-4000-8000-000000000001",
  RAW_ARCHIVE_ACCOUNT: "fixturearchive", RAW_ARCHIVE_CONTAINER: "raw",
  METRICS_SYNC_SCHEDULE: "0 0 2 * * *",
};
const now = () => new Date("2026-10-26T01:00:00Z");
const invocationId = "00000000-0000-4000-8000-000000000002";

function harness() {
  const context = { invocationId, info: vi.fn(), error: vi.fn() };
  const dependencies: MetricsBackfillDependencies = {
    resolveOrganization: vi.fn(async () => 123),
    acquire: vi.fn(async () => ({ organizationId: 123, content: new TextEncoder().encode("{}\n") })),
    isComplete: vi.fn(async () => false),
    load: vi.fn<MetricsBackfillDependencies["load"]>(async () => ({
      runId: "00000000-0000-4000-8000-000000000003", status: "published",
      rowsRead: 1, rowsLoaded: 1, rowsQuarantined: 0, issues: 0, artifactId: 1, blobPath: "raw/fixture",
    })),
    recordFailure: vi.fn(async () => undefined),
    logger: { info: vi.fn(), error: vi.fn() },
  };
  const createDependencies = vi.fn(() => dependencies);
  return { context, dependencies, createDependencies };
}

describe("metrics runtime composition", () => {
  it("maps only existing metrics settings and does not use OAuth, PAT, or installation fallback inputs", () => {
    const config = readMetricsRuntimeConfig({
      ...env, AUTH_GITHUB_ID: "OAUTH_MARKER", GITHUB_DIRECTORY_PAT: "PAT_MARKER",
      GITHUB_APP_INSTALLATION_ID: "999",
    }, "2026-10-26");
    expect(config.settings).toMatchObject({
      githubAppId: "17", organizations: ["fixture-org"], sqlDatabase: "fixture",
      rawArchiveAccount: "fixturearchive", rawArchiveContainer: "raw",
    });
    expect(config).not.toHaveProperty("installationId");
    expect(JSON.stringify(config.settings)).not.toMatch(/OAUTH_MARKER|PAT_MARKER/);
  });

  it.each([
    { GITHUB_APP_ID: "" }, { GITHUB_APP_PRIVATE_KEY: "" }, { GITHUB_APP_PRIVATE_KEY: "PRIVATE_MARKER" },
    { GITHUB_APP_PRIVATE_KEY: "@Microsoft.KeyVault(SecretUri=https://fixture.invalid/SECRET_MARKER)" },
    { ORGANIZATIONS: "fixture-org,FIXTURE-org" }, { SQL_SERVER: "" }, { AZURE_CLIENT_ID: "bad-guid" },
    { RAW_ARCHIVE_CONTAINER: "" }, { BACKFILL_FROM: "2026-10-26" }, { BACKFILL_FROM: "2020-01-01" },
    { METRICS_SYNC_SCHEDULE: "" }, { METRICS_SYNC_SCHEDULE: "not cron" },
  ])("fails invalid required config without echoing its value: %j", (change) => {
    const h = harness();
    expect(() => createMetricsRuntimeHandler({ ...env, ...change }, { now, createDependencies: h.createDependencies }))
      .toThrow("metrics_configuration_invalid");
    expect(h.createDependencies).not.toHaveBeenCalled();
  });

  it("does not initialize dependencies at module load or handler construction", () => {
    const h = harness();
    createMetricsRuntimeHandler(env, { now, createDependencies: h.createDependencies });
    expect(h.createDependencies).not.toHaveBeenCalled();
  });

  it("invokes the actual backfill usecase with yesterday, safe resume, and the invocation correlation", async () => {
    const h = harness();
    const handler = createMetricsRuntimeHandler(env, { now, createDependencies: h.createDependencies });
    await handler({}, h.context);
    expect(h.dependencies.isComplete).toHaveBeenCalledWith(123, "2026-10-25");
    expect(h.dependencies.load).toHaveBeenCalledWith(expect.objectContaining({ reportDay: "2026-10-25", correlationId: invocationId }));
    expect(h.createDependencies).toHaveBeenCalledWith(expect.objectContaining({ privateKey: key }), expect.any(Object), invocationId);
    expect(JSON.stringify(h.context.info.mock.calls)).not.toContain(key);
  });

  it("does not write in dry-run and surfaces a gap as failed runtime rather than a healthy timer", async () => {
    const h = harness();
    vi.mocked(h.dependencies.acquire).mockRejectedValue(new Error("PERSONAL_MARKER PRIVATE_MARKER"));
    const handler = createMetricsRuntimeHandler(env, { now, dryRun: true, createDependencies: h.createDependencies });
    await expect(handler({}, h.context)).rejects.toThrow("metrics_runtime_incomplete");
    expect(h.dependencies.load).not.toHaveBeenCalled();
    expect(h.dependencies.recordFailure).not.toHaveBeenCalled();
    expect(JSON.stringify([...h.context.info.mock.calls, ...h.context.error.mock.calls]))
      .not.toMatch(/PERSONAL_MARKER|PRIVATE_MARKER/);
  });

  it("fails quarantined days and sanitizes unexpected persistence errors", async () => {
    const h = harness();
    vi.mocked(h.dependencies.load).mockRejectedValue(new Error("SQL_SECRET_MARKER"));
    await expect(createMetricsRuntimeHandler(env, { now, createDependencies: h.createDependencies })({}, h.context))
      .rejects.toThrow("metrics_runtime_failed");
    expect(JSON.stringify(h.context.error.mock.calls)).not.toContain("SQL_SECRET_MARKER");
  });

  it("fails the timer after a loader failure, but only once every other day has been tried", async () => {
    const h = harness();
    vi.mocked(h.dependencies.load).mockRejectedValueOnce(new Error("archive_write_failed"));
    const handler = createMetricsRuntimeHandler({ ...env, BACKFILL_FROM: "2026-10-23" }, {
      now, createDependencies: h.createDependencies,
    });
    await expect(handler({}, h.context)).rejects.toThrow("metrics_runtime_failed");
    expect(h.dependencies.load).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(h.context.error.mock.calls)).toContain("load_failed");
  });

  it("revalidates a backfill window that expires while the host remains alive", async () => {
    const h = harness();
    let clock = new Date("2026-10-26T01:00:00Z");
    const handler = createMetricsRuntimeHandler({ ...env, BACKFILL_FROM: "2025-10-26" }, {
      now: () => clock, createDependencies: h.createDependencies,
    });
    clock = new Date("2026-10-27T01:00:00Z");
    await expect(handler({}, h.context)).rejects.toThrow("metrics_configuration_invalid");
    expect(h.createDependencies).not.toHaveBeenCalled();
  });
});
