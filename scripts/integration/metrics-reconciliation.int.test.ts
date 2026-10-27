import { randomUUID } from "node:crypto";
import sql from "mssql";
import { BlobServiceClient } from "@azure/storage-blob";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../db/migrate";
import { localConnectionString } from "../stack/config";
import { loadMetricsDay } from "../../functions/src/metrics/day-loader";
import { createMetricsReconciliationReader } from "../../functions/src/reconciliation/reader";
import { createManifest, reconcileMetricsRange } from "../../functions/src/reconciliation/report";
import { assertPublicSummary } from "../../shared/src/reconciliation";

const database = `metrics_reconciliation_${process.pid}`;
const connection = localConnectionString(process.env, database);
const sqlConfig = sql.ConnectionPool.parseConnectionString(connection);
const container = BlobServiceClient.fromConnectionString(process.env.AZURITE_CONNECTION_STRING ?? "UseDevelopmentStorage=true")
  .getContainerClient(`metrics-reconciliation-${process.pid}`);
const organizationId = 700_000_000 + process.pid;
const userId = 1_500_000_000 + process.pid;
let sequence = 0;
let pool: sql.ConnectionPool;
const read = createMetricsReconciliationReader(sqlConfig, container);
const logger = { info: vi.fn(), error: vi.fn() };
const provenance = {
  sourceLabel: "legacy raw", retrievedAt: "2026-03-20T00:00:00Z", approvalRef: "private-approval-marker", toolVersion: "1",
};
async function seed(reject = false, fatal = false) {
  const reportDay = `2026-03-${String(++sequence).padStart(2, "0")}`;
  const row = {
    day: reportDay, organization_id: organizationId, user_id: userId, user_login: "private-identity-marker",
    user_initiated_interaction_count: 2, code_generation_activity_count: 1, code_acceptance_activity_count: 0,
    loc_suggested_to_add_sum: 3, loc_suggested_to_delete_sum: 0, loc_added_sum: 1, loc_deleted_sum: 0,
  };
  const content = Buffer.from(JSON.stringify(row) + "\n" +
    (reject ? JSON.stringify({ ...row, user_id: userId + 1, totals_by_cli: { prompt_count: -1 } }) + "\n" : "") +
    (fatal ? JSON.stringify(row) + "\n" : ""));
  const loaded = await loadMetricsDay({
    organizationId, organizationLogin: "example-reconciliation", reportDay, content,
    runId: randomUUID(), correlationId: randomUUID(),
  }, { sqlConfig, blobContainer: container, logger });
  const manifest = createManifest(content, { organizationId, reportDay, provenance, includePerUser: true });
  return { reportDay, content, loaded, manifest };
}
async function report(reportDay: string, manifests: readonly unknown[], to = reportDay) {
  return reconcileMetricsRange({ organizationId, from: reportDay, to, manifests, correlationId: randomUUID() }, { read, logger });
}
describe("metrics reconciliation (SQL Server + Azurite, synthetic only)", () => {
  beforeAll(async () => {
    const master = await new sql.ConnectionPool(localConnectionString(process.env, "master")).connect();
    try {
      await master.batch(`CREATE DATABASE [${database}]`);
    } finally { await master.close(); }
    await migrate({ connectionString: connection });
    await container.create();
    pool = await new sql.ConnectionPool(connection).connect();
  }, 240_000);
  afterAll(async () => {
    await pool?.close();
    await container.deleteIfExists();
    const master = await new sql.ConnectionPool(localConnectionString(process.env, "master")).connect();
    try {
      await master.batch(`IF DB_ID(N'${database}') IS NOT NULL BEGIN
        ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END`);
    } finally { await master.close(); }
  }, 120_000);
  it("matches facts, lineage and independently downloaded archived bytes without SQL writes", async () => {
    const fixture = await seed();
    const before = await pool.request().query("SELECT COUNT(*) AS n FROM portal.IngestionRun");
    const result = await report(fixture.reportDay, [fixture.manifest]);
    expect(result.summary.status).toBe("matched");
    expect(assertPublicSummary(result.summary)).toEqual(result.summary);
    expect((await pool.request().query("SELECT COUNT(*) AS n FROM portal.IngestionRun")).recordset).toEqual(before.recordset);
    const publicText = JSON.stringify([result.summary, logger.info.mock.calls, logger.error.mock.calls]);
    for (const marker of ["private-identity-marker", provenance.approvalRef, String(organizationId), String(userId), fixture.loaded.blobPath]) {
      expect(publicText).not.toContain(marker);
    }
  });
  it("does not match missing published runs", async () => {
    const fixture = await seed();
    await pool.request().input("run", sql.UniqueIdentifier, fixture.loaded.runId)
      .query("UPDATE portal.IngestionRun SET is_current = 0 WHERE run_id = @run");
    expect((await report(fixture.reportDay, [fixture.manifest])).summary.status).toBe("incomplete");
  });
  it("detects SQL metric mismatches", async () => {
    const fixture = await seed();
    await pool.request().input("run", sql.UniqueIdentifier, fixture.loaded.runId)
      .query("UPDATE portal.fact_user_daily_usage SET interaction_count = 9 WHERE run_id = @run");
    const result = await report(fixture.reportDay, [fixture.manifest]);
    expect(result.summary.status).toBe("unexplained");
    expect(result.details[0]!.perUserDifferences[0]).toMatchObject({ kind: "value_mismatch" });
  });
  it("explains rejected rows only with supporting SQL line/hash evidence", async () => {
    const fixture = await seed(true);
    expect(fixture.loaded.status).toBe("published");
    expect((await report(fixture.reportDay, [fixture.manifest])).summary.status).toBe("explained");
    await pool.request().input("run", sql.UniqueIdentifier, fixture.loaded.runId)
      .query("UPDATE portal.ValidationIssue SET raw_row_sha256 = REPLICATE('0',64) WHERE run_id = @run AND severity = 'reject'");
    expect((await report(fixture.reportDay, [fixture.manifest])).summary.status).toBe("incomplete");
  });
  it("keeps a quarantined duplicate day incomplete", async () => {
    const fixture = await seed(false, true);
    expect(fixture.loaded.status).toBe("quarantined");
    expect((await report(fixture.reportDay, [fixture.manifest])).summary.status).toBe("incomplete");
  });
  it("reports missing archives as unavailable, not empty", async () => {
    const fixture = await seed();
    await container.getBlobClient(fixture.loaded.blobPath).delete();
    expect((await report(fixture.reportDay, [fixture.manifest])).summary.status).toBe("unavailable");
  });
  it("reports invalid manifests, unavailable evidence and partial coverage without matches", async () => {
    const fixture = await seed();
    expect((await report(fixture.reportDay, [{ reportDay: fixture.reportDay }])).summary.status).toBe("incomplete");
    expect((await report(fixture.reportDay, [])).summary.status).toBe("unavailable");
    const next = `2026-03-${String(sequence + 1).padStart(2, "0")}`;
    const result = await report(fixture.reportDay, [fixture.manifest], next);
    expect(result.summary.status).toBe("unavailable");
    expect(result.summary.days.map((day) => day.status)).toEqual(["matched", "unavailable"]);
  });
});
