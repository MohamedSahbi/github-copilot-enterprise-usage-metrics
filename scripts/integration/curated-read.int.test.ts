import type sql from "mssql";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openPool } from "./db";

// Seeds its own curated rows (named columns only) and reads them the way the scoped read API will: aggregates per organization.
const ORG_A = 990000001;
const ORG_B = 990000002;
const USERS = [990001001, 990001002, 990001003];
const RUN = "00000000-0000-4000-8000-0000000000c1";
const DAY = "2026-03-02";

let pool: sql.ConnectionPool;

async function cleanup(): Promise<void> {
  const q = (text: string) => pool.request().query(text);
  await q(`DELETE FROM portal.fact_user_daily_usage WHERE organization_id IN (${ORG_A}, ${ORG_B})`);
  await q(`DELETE FROM portal.dim_user WHERE user_id IN (${USERS.join(",")})`);
  await q(`DELETE FROM portal.dim_organization WHERE organization_id IN (${ORG_A}, ${ORG_B})`);
  await q(`DELETE FROM portal.SourceArtifact WHERE run_id = '${RUN}'`);
  await q(`DELETE FROM portal.IngestionRun WHERE run_id = '${RUN}'`);
}

async function seed(): Promise<void> {
  const q = (text: string) => pool.request().query(text);
  await q(`INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, report_day, status, is_current, transform_version)
           VALUES ('${RUN}', 'users_1_day', 'example-enterprise', '${DAY}', 'published', 1, '1')`);
  const art = await q(`INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes)
                       OUTPUT INSERTED.artifact_id VALUES ('${RUN}', 'raw', 'integration/curated.ndjson', '${"a".repeat(64)}', 1)`);
  const artifact = Number(art.recordset[0]!.artifact_id);
  await q(`INSERT INTO portal.dim_organization (organization_id, login) VALUES (${ORG_A}, 'example-org-a'), (${ORG_B}, 'example-org-b')`);
  await q(`INSERT INTO portal.dim_user (user_id, login) VALUES ${USERS.map((u) => `(${u}, 'user-${u}')`).join(", ")}`);
  const fact = (org: number, user: number, interactions: number) =>
    `(${org}, ${user}, '${DAY}', ${interactions}, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1.5, '${RUN}', ${artifact}, '1')`;
  await q(`INSERT INTO portal.fact_user_daily_usage (organization_id, user_id, usage_day, interaction_count, code_generation_count,
      code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete, loc_added, loc_deleted, used_agent, used_chat, used_cli,
      used_coding_agent, used_cloud_agent, used_copilot_app, used_vscode_agent, used_code_review_active, used_code_review_passive,
      ai_credits_used, run_id, source_artifact_id, transform_version)
      VALUES ${[fact(ORG_A, USERS[0]!, 10), fact(ORG_A, USERS[1]!, 5), fact(ORG_B, USERS[2]!, 7)].join(", ")}`);
}

describe("curated read (fact_user_daily_usage)", () => {
  beforeAll(async () => {
    pool = await openPool();
  });
  afterAll(async () => {
    await cleanup();
    await pool.close();
  });
  beforeEach(async () => {
    await cleanup();
    await seed();
  });
  afterEach(cleanup);

  it("aggregates usage per organization for a day range", async () => {
    const rows = (
      await pool.request().query(`
        SELECT f.organization_id, SUM(f.interaction_count) AS interactions, COUNT(DISTINCT f.user_id) AS users
        FROM portal.fact_user_daily_usage f
        WHERE f.organization_id IN (${ORG_A}, ${ORG_B}) AND f.usage_day BETWEEN '${DAY}' AND '${DAY}'
        GROUP BY f.organization_id ORDER BY f.organization_id`)
    ).recordset;
    expect(rows.map((r) => [Number(r.organization_id), Number(r.interactions), Number(r.users)])).toEqual([
      [ORG_A, 15, 2],
      [ORG_B, 7, 1],
    ]);
  });

  it("joins the user dimension for per-user detail", async () => {
    const rows = (
      await pool.request().query(`
        SELECT u.login, f.interaction_count FROM portal.fact_user_daily_usage f
        JOIN portal.dim_user u ON u.user_id = f.user_id
        WHERE f.organization_id = ${ORG_A} ORDER BY f.interaction_count DESC`)
    ).recordset;
    expect(rows.map((r) => [r.login, r.interaction_count])).toEqual([
      [`user-${USERS[0]}`, 10],
      [`user-${USERS[1]}`, 5],
    ]);
  });

  it("refuses a fact row for an unknown user (referential integrity)", async () => {
    await expect(
      pool.request().query(`INSERT INTO portal.fact_user_daily_usage (organization_id, user_id, usage_day, interaction_count, code_generation_count,
        code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete, loc_added, loc_deleted, used_agent, used_chat, used_cli,
        used_coding_agent, used_cloud_agent, used_copilot_app, used_vscode_agent, used_code_review_active, used_code_review_passive,
        ai_credits_used, run_id, source_artifact_id, transform_version)
        SELECT ${ORG_A}, 999999999, '${DAY}', 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, run_id, artifact_id, '1' FROM portal.SourceArtifact WHERE run_id = '${RUN}'`),
    ).rejects.toThrow(/FK_fact_user_daily_user/);
  });
});
