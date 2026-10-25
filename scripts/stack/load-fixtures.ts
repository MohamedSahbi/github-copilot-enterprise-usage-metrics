// Loads the synthetic fixtures into the staging tables of a LOCAL database, using the reference staging mapper.
// Local-only: the single writer of stg_* in a real environment is ingestion (D-34). Re-runnable: replaces its own runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sql from "mssql";
import { createStagingContext, mapUsersDayLine } from "../contracts/reference/staging";
import { WINDOW } from "../contracts/synthetic";
import { assertLocalHost, FIXTURE_BLOB_CONTAINER, FIXTURE_SCOPE_KEY, planFixtureRuns, sha256Hex } from "./config";

const FIXTURE_DIR = join(__dirname, "..", "..", "fixtures", "synthetic");

async function insert(tx: sql.Transaction, table: string, row: object): Promise<void> {
  const entries = Object.entries(row);
  const request = new sql.Request(tx);
  entries.forEach(([, value], i) => request.input(`p${i}`, value));
  const columns = entries.map(([key]) => `[${key}]`).join(", ");
  const params = entries.map((_, i) => `@p${i}`).join(", ");
  await request.query(`INSERT INTO portal.${table} (${columns}) VALUES (${params})`);
}

export interface FixtureLoadResult {
  runs: Array<{ runId: string; file: string; lines: number; loaded: number; issues: number }>;
}

export async function loadFixtures(connectionString: string): Promise<FixtureLoadResult> {
  assertLocalHost(connectionString);
  const pool = await new sql.ConnectionPool(connectionString).connect();
  const result: FixtureLoadResult = { runs: [] };
  try {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      for (const run of planFixtureRuns()) {
        const text = readFileSync(join(FIXTURE_DIR, run.file), "utf8");
        const lines = text.split("\n").filter(Boolean);

        for (const table of ["stg_user_family_count", "stg_user_breakdown", "stg_user_daily", "ValidationIssue", "SourceArtifact"]) {
          await new sql.Request(tx).input("run", sql.UniqueIdentifier, run.runId).query(`DELETE FROM portal.${table} WHERE run_id = @run`);
        }
        await new sql.Request(tx).input("run", sql.UniqueIdentifier, run.runId).query("DELETE FROM portal.IngestionRun WHERE run_id = @run");

        await new sql.Request(tx)
          .input("run", sql.UniqueIdentifier, run.runId)
          .input("scope", sql.NVarChar, FIXTURE_SCOPE_KEY)
          .input("start", sql.Date, WINDOW.start)
          .input("end", sql.Date, WINDOW.end)
          .query(
            `INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, range_start, range_end, status, transform_version, rows_read)
             VALUES (@run, 'users_1_day', @scope, @start, @end, 'staged', '1', ${lines.length})`,
          );
        const artifact = await new sql.Request(tx)
          .input("run", sql.UniqueIdentifier, run.runId)
          .input("container", sql.NVarChar, FIXTURE_BLOB_CONTAINER)
          .input("path", sql.NVarChar, run.blobPath)
          .input("sha", sql.Char, sha256Hex(text))
          .input("size", sql.BigInt, Buffer.byteLength(text))
          .query<{ artifact_id: number }>(
            `INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes, row_count)
             OUTPUT INSERTED.artifact_id VALUES (@run, @container, @path, @sha, @size, ${lines.length})`,
          );
        const artifactId = Number(artifact.recordset[0]!.artifact_id);

        const ctx = createStagingContext(run.runId, WINDOW);
        let loaded = 0;
        let issues = 0;
        for (const [index, line] of lines.entries()) {
          const mapped = mapUsersDayLine(line, index + 1, ctx, artifactId);
          if (mapped.loaded && mapped.daily) {
            loaded++;
            await insert(tx, "stg_user_daily", mapped.daily);
            for (const row of mapped.breakdown) await insert(tx, "stg_user_breakdown", row);
            for (const row of mapped.families) await insert(tx, "stg_user_family_count", row);
          }
          for (const issue of mapped.issues) {
            issues++;
            await insert(tx, "ValidationIssue", issue);
          }
        }
        result.runs.push({ runId: run.runId, file: run.file, lines: lines.length, loaded, issues });
      }
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  } finally {
    await pool.close();
  }
  return result;
}
