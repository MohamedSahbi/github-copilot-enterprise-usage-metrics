import { readFileSync } from "node:fs";
import { join } from "node:path";
import type sql from "mssql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { INVALID_EXPECTED } from "../contracts/synthetic";
import { planFixtureRuns } from "../stack/config";
import { loadFixtures } from "../stack/load-fixtures";
import { connectionString, openPool } from "./db";

const [VALID, INVALID] = planFixtureRuns();
const lineCount = (file: string) => readFileSync(join(__dirname, "..", "..", "fixtures", "synthetic", file), "utf8").split("\n").filter(Boolean).length;

let pool: sql.ConnectionPool;

const scalar = async (text: string, run?: string): Promise<number> => {
  const request = pool.request();
  if (run) request.input("run", run);
  return Number((await request.query(text)).recordset[0]!.n);
};

describe("staging load (fixtures → stg_*)", () => {
  beforeAll(async () => {
    pool = await openPool();
  });
  afterAll(async () => {
    await pool.close();
  });
  // Reset: the loader replaces its own runs, so every test starts from the same state.
  beforeEach(async () => {
    await loadFixtures(connectionString);
  });

  it("stages every line of the valid file under one staged run", async () => {
    const n = lineCount(VALID!.file);
    expect(await scalar("SELECT COUNT(*) AS n FROM portal.stg_user_daily WHERE run_id = @run", VALID!.runId)).toBe(n);
    expect(await scalar("SELECT COUNT(*) AS n FROM portal.ValidationIssue WHERE run_id = @run", VALID!.runId)).toBe(0);
    const run = (await pool.request().input("run", VALID!.runId).query("SELECT status, rows_read FROM portal.IngestionRun WHERE run_id = @run")).recordset[0]!;
    expect(run.status).toBe("staged");
    expect(run.rows_read).toBe(n);
  });

  it("stages only loadable lines of the invalid file and records issues for the rest", async () => {
    const loadable = INVALID_EXPECTED.filter((e) => e.loaded).length;
    expect(await scalar("SELECT COUNT(*) AS n FROM portal.stg_user_daily WHERE run_id = @run", INVALID!.runId)).toBe(loadable);
    expect(await scalar("SELECT COUNT(*) AS n FROM portal.ValidationIssue WHERE run_id = @run", INVALID!.runId)).toBeGreaterThan(0);
  });

  it("is re-runnable without duplicating rows", async () => {
    const before = await scalar("SELECT COUNT(*) AS n FROM portal.stg_user_daily WHERE run_id = @run", VALID!.runId);
    await loadFixtures(connectionString);
    expect(await scalar("SELECT COUNT(*) AS n FROM portal.stg_user_daily WHERE run_id = @run", VALID!.runId)).toBe(before);
  });

  it("rejects a duplicate (run, organization, user, day) key at the database", async () => {
    const dup = pool.request().input("run", VALID!.runId).query(`
      INSERT INTO portal.stg_user_daily (run_id, artifact_id, line_number, organization_id, user_id, usage_day,
        interaction_count, code_generation_count, code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete,
        loc_added, loc_deleted, used_agent, used_chat, used_cli, used_coding_agent, used_cloud_agent, used_copilot_app,
        used_vscode_agent, used_code_review_active, used_code_review_passive, ai_credits_used)
      SELECT TOP (1) run_id, artifact_id, 100000, organization_id, user_id, usage_day,
        interaction_count, code_generation_count, code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete,
        loc_added, loc_deleted, used_agent, used_chat, used_cli, used_coding_agent, used_cloud_agent, used_copilot_app,
        used_vscode_agent, used_code_review_active, used_code_review_passive, ai_credits_used
      FROM portal.stg_user_daily WHERE run_id = @run`);
    await expect(dup).rejects.toThrow(/UX_stg_user_daily_key/);
  });
});
