import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type sql from "mssql";
import { TEST_CURATED_RUN_IDS } from "../stack/test-only-curated-seed";
import { loadLocalCuratedData } from "../stack/local-curated-data";
import { removeRuns } from "../data/remove-runs";
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
    const result = await removeRuns(pool, { runIds, userIds: [], organizationIds: [], execute: false });
    expect(result).toMatchObject({ committed: false, runs: 2, factRows: facts });
    expect(result.deleted.IngestionRun).toBe(2);
    expect(await count("IngestionRun")).toBe(2);
    expect(await count("fact_user_daily_usage") + await count("fact_ai_credit_line")).toBe(facts);
  });

  it("refuses to commit when the expected fact-row count does not match", async () => {
    await expect(removeRuns(pool, { runIds, userIds: [], organizationIds: [], execute: true, expectFactRows: 1 }))
      .rejects.toMatchObject({ code: "fact_row_count_mismatch" });
    expect(await count("IngestionRun")).toBe(2);
  });

  it("refuses unknown run ids", async () => {
    await expect(removeRuns(pool, {
      runIds: [...runIds, "00000000-0000-4000-8000-0000000000ff"], userIds: [], organizationIds: [], execute: false,
    })).rejects.toMatchObject({ code: "run_not_found" });
  });

  it("deletes the runs, their facts, staging rows, artifacts and issues in one commit", async () => {
    const preview = await removeRuns(pool, { runIds, userIds: [], organizationIds: [], execute: false });
    const result = await removeRuns(pool, {
      runIds, userIds: [], organizationIds: [], execute: true, expectFactRows: preview.factRows,
    });
    expect(result).toMatchObject({ committed: true, factRows: preview.factRows });
    for (const table of ["fact_user_daily_usage", "fact_usage_breakdown", "fact_ai_credit_line", "SourceArtifact", "IngestionRun"]) {
      expect(await count(table)).toBe(0);
    }
  });
});
