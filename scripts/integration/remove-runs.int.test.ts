import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type sql from "mssql";
import { TEST_CURATED_RUN_IDS } from "../stack/test-only-curated-seed";
import { loadLocalCuratedData } from "../stack/local-curated-data";
import { removeRuns } from "../data/remove-runs";
import { readRunStatus } from "../data/run-status";
import { connectionString, openPool } from "./db";

let pool: sql.ConnectionPool;
const runIds = [TEST_CURATED_RUN_IDS.usage, TEST_CURATED_RUN_IDS.aiCredits];

async function count(table: string): Promise<number> {
  const result = await pool.request()
    .input("usage", TEST_CURATED_RUN_IDS.usage)
    .input("credits", TEST_CURATED_RUN_IDS.aiCredits)
    .query(`SELECT COUNT(*) AS n FROM portal.${table} WHERE run_id IN (@usage, @credits)`);
  return Number((result.recordset[0] as { n: number }).n);
}

describe("remove-runs against the synthetic seed", () => {
  beforeAll(async () => {
    pool = await openPool();
    await loadLocalCuratedData(connectionString);
  });

  afterAll(async () => {
    await loadLocalCuratedData(connectionString);
    await pool.close();
  });

  it("dry run reports the rows it would delete and changes nothing", async () => {
    const facts = await count("fact_user_daily_usage") + await count("fact_ai_credit_line");
    const result = await removeRuns(pool, { runIds, synthetic: false, userIds: [], organizationIds: [], execute: false });
    expect(result).toMatchObject({ committed: false, runs: 2, factRows: facts });
    expect(result.deleted.IngestionRun).toBe(2);
    expect(await count("IngestionRun")).toBe(2);
    expect(await count("fact_user_daily_usage") + await count("fact_ai_credit_line")).toBe(facts);
  });

  it("refuses to commit when the expected fact-row count does not match", async () => {
    await expect(removeRuns(pool, { runIds, synthetic: false, userIds: [], organizationIds: [], execute: true, expectFactRows: 1 }))
      .rejects.toMatchObject({ code: "fact_row_count_mismatch" });
    expect(await count("IngestionRun")).toBe(2);
  });

  it("--synthetic finds published metrics runs without a loader archive path, and run-status flags them", async () => {
    const scope = "int-test-run-status";
    const loader = "00000000-0000-4000-8000-0000000000d1";
    const seeded = "00000000-0000-4000-8000-0000000000d2";
    const insert = (runId: string, day: string, blobPath: string) => pool.request()
      .input("run", runId).input("scope", scope).input("day", day).input("path", blobPath)
      .query(`
        INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, report_day, status, is_current, transform_version, rows_loaded, rows_quarantined)
        VALUES (@run, 'users_1_day', @scope, @day, 'published', 1, '1', 4, 1);
        INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes, row_count)
        VALUES (@run, 'raw', @path, REPLICATE('0', 64), 0, 4);`);
    try {
      await insert(loader, "2026-09-01", `raw/users_1_day/acme/2026/09/01/${loader}.ndjson`);
      await insert(seeded, "2026-09-02", "seed/usage.ndjson");

      const preview = await removeRuns(pool, { runIds: [], synthetic: true, userIds: [], organizationIds: [], execute: false });
      expect(preview.committed).toBe(false);
      expect(preview.runIds).toContain(seeded);
      expect(preview.runIds).toContain(TEST_CURATED_RUN_IDS.usage);
      expect(preview.runIds).not.toContain(loader);
      expect(preview.runIds).not.toContain(TEST_CURATED_RUN_IDS.aiCredits);

      const status = await readRunStatus(pool, { from: "2026-09-01", to: "2026-09-03" });
      const days = status.days.filter((day) => day.scope === scope);
      expect(days).toEqual([
        { day: "2026-09-01", scope, state: "published", rowsLoaded: 4, rowsQuarantined: 1, failedAttempts: 0 },
        { day: "2026-09-02", scope, state: "published", rowsLoaded: 4, rowsQuarantined: 1, failedAttempts: 0, synthetic: true },
        { day: "2026-09-03", scope, state: "gap", rowsLoaded: 0, rowsQuarantined: 0, failedAttempts: 0 },
      ]);
      expect(status.syntheticRunIds).toContain(seeded);
      expect(status.syntheticRunIds).not.toContain(loader);
    } finally {
      await pool.request().input("loader", loader).input("seeded", seeded).query(`
        DELETE FROM portal.SourceArtifact WHERE run_id IN (@loader, @seeded);
        DELETE FROM portal.IngestionRun WHERE run_id IN (@loader, @seeded);`);
    }
  });

  it("refuses unknown run ids", async () => {
    await expect(removeRuns(pool, {
      runIds: [...runIds, "00000000-0000-4000-8000-0000000000ff"], synthetic: false, userIds: [], organizationIds: [], execute: false,
    })).rejects.toMatchObject({ code: "run_not_found" });
  });

  it("deletes the runs, their facts, staging rows, artifacts and issues in one commit", async () => {
    const preview = await removeRuns(pool, { runIds, synthetic: false, userIds: [], organizationIds: [], execute: false });
    const result = await removeRuns(pool, {
      runIds, synthetic: false, userIds: [], organizationIds: [], execute: true, expectFactRows: preview.factRows,
    });
    expect(result).toMatchObject({ committed: true, factRows: preview.factRows });
    for (const table of ["fact_user_daily_usage", "fact_usage_breakdown", "fact_ai_credit_line", "SourceArtifact", "IngestionRun"]) {
      expect(await count(table)).toBe(0);
    }
  });
});
