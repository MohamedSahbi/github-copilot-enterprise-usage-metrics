import sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthorizedUsageAccess } from "../../portal/src/usage/api";
import { getUsageBreakdown } from "../../portal/src/usage/sql-usage";
import { openPool } from "./db";

const ORGANIZATION_ID = 990119001;
const RUN_ID = "00000000-0000-4000-8000-000000000119";
const OBJECT_ID = "00000000-0000-4000-8000-000000001191";
const access: AuthorizedUsageAccess = {
  state: "authorized",
  breakGlass: false,
  principal: {
    principal_id: RUN_ID, entra_tenant_id: RUN_ID, entra_object_id: OBJECT_ID,
    github_user_id: null, status: "active",
  },
  grants: [{ role: "executive", scope: "department", scope_value: "app-test" }],
  namesVisible: false,
};
let pool: sql.ConnectionPool;

async function cleanup(): Promise<void> {
  await pool.request().input("org", sql.BigInt, ORGANIZATION_ID).input("run", sql.UniqueIdentifier, RUN_ID).query(`
    DELETE FROM portal.fact_usage_breakdown WHERE organization_id IN (@org, @org + 1);
    DELETE FROM portal.fact_user_daily_usage WHERE organization_id IN (@org, @org + 1);
    DELETE FROM portal.dim_user WHERE user_id BETWEEN @org AND @org + 6;
    DELETE FROM portal.dim_organization WHERE organization_id IN (@org, @org + 1);
    DELETE FROM portal.SourceArtifact WHERE run_id = @run;
    DELETE FROM portal.IngestionRun WHERE run_id = @run;
  `);
}

function breakdown(from = "2026-03-02", to = from, page = 1) {
  return getUsageBreakdown(pool, access, {
    from, to, organizationIds: [ORGANIZATION_ID], kind: "ide", page, pageSize: 10,
  }, RUN_ID);
}

describe("feature-backed Copilot App IDE SQL read model", () => {
  beforeAll(async () => {
    pool = await openPool();
    await cleanup();
    await pool.request().input("org", sql.BigInt, ORGANIZATION_ID)
      .input("run", sql.UniqueIdentifier, RUN_ID).input("object", sql.UniqueIdentifier, OBJECT_ID).query(`
      SET XACT_ABORT ON;
      INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, report_day, status, is_current, transform_version)
        VALUES (@run, 'users_1_day', 'app-ide-integration', '2026-03-02', 'published', 0, '1');
      INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes)
        VALUES (@run, 'raw', 'integration/app-ide.ndjson', REPLICATE('a', 64), 1);
      DECLARE @artifact BIGINT = SCOPE_IDENTITY();
      INSERT INTO portal.dim_organization (organization_id, login)
        VALUES (@org, 'app-ide-test'), (@org + 1, 'app-ide-other');
      INSERT INTO portal.dim_user (user_id, entra_object_id, department, state)
        SELECT @org + n, CASE WHEN n = 0 THEN @object ELSE NULL END,
          CASE WHEN n = 5 THEN 'outside-app-test' ELSE 'app-test' END,
          CASE WHEN n = 6 THEN 'suspended' ELSE 'active' END
        FROM (VALUES (0), (1), (2), (3), (4), (5), (6)) AS users(n);
      INSERT INTO portal.fact_user_daily_usage (
        organization_id, user_id, usage_day, interaction_count, code_generation_count, code_acceptance_count,
        loc_suggested_to_add, loc_suggested_to_delete, loc_added, loc_deleted, used_agent, used_chat, used_cli,
        used_coding_agent, used_cloud_agent, used_copilot_app, used_vscode_agent, used_code_review_active,
        used_code_review_passive, ai_credits_used, run_id, source_artifact_id, transform_version
      )
        SELECT org, @org + n, day, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, @run, @artifact, '1'
        FROM (VALUES
          (@org, 0, '2026-03-02'), (@org, 1, '2026-03-02'), (@org, 2, '2026-03-02'),
          (@org, 3, '2026-03-02'), (@org, 4, '2026-03-02'), (@org, 5, '2026-03-02'),
          (@org, 6, '2026-03-02'), (@org, 0, '2026-03-03'), (@org, 1, '2026-03-03'),
          (@org, 2, '2026-03-03'), (@org, 3, '2026-03-03'), (@org, 4, '2026-03-03'),
          (@org, 0, '2026-03-04'), (@org, 0, '2026-03-05'), (@org, 1, '2026-03-05'),
          (@org, 2, '2026-03-05'), (@org, 3, '2026-03-05'), (@org, 4, '2026-03-05'),
          (@org, 0, '2026-03-06'), (@org, 1, '2026-03-06'), (@org, 2, '2026-03-06'),
          (@org, 3, '2026-03-06'), (@org, 4, '2026-03-06'), (@org + 1, 2, '2026-03-02'),
          (@org, 0, '2026-03-07'), (@org, 1, '2026-03-07'), (@org, 2, '2026-03-07'),
          (@org, 3, '2026-03-07'), (@org, 4, '2026-03-07'), (@org, 0, '2026-03-08'),
          (@org, 0, '2026-03-09'), (@org, 1, '2026-03-09'), (@org, 2, '2026-03-09'),
          (@org, 3, '2026-03-09'), (@org, 4, '2026-03-09'), (@org, 0, '2026-03-11')
        ) AS days(org, n, day);
      INSERT INTO portal.fact_usage_breakdown (
        organization_id, user_id, usage_day, breakdown_kind, key_1, key_2, interaction_count,
        code_generation_count, code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete,
        loc_added, loc_deleted, run_id, source_artifact_id, transform_version
      )
        SELECT org, @org + n, day, kind, name, N'', interactions, 0, 0, 0, 0, 0, 0, @run, @artifact, '1'
        FROM (VALUES
          (@org, 0, '2026-03-02', 'feature', N'copilot_app', 10),
          (@org, 0, '2026-03-02', 'ide', N'copilot_app', 99),
          (@org, 1, '2026-03-02', 'feature', N'copilot_app', 0),
          (@org, 1, '2026-03-02', 'ide', N'copilot_app', 99),
          (@org, 2, '2026-03-02', 'ide', N'copilot_app', 4),
          (@org, 3, '2026-03-02', 'feature', N'copilot_app', 3),
          (@org, 4, '2026-03-02', 'feature', N'copilot_app', 2),
          (@org, 5, '2026-03-02', 'feature', N'copilot_app', 1000),
          (@org, 6, '2026-03-02', 'feature', N'copilot_app', 5000),
          (@org, 0, '2026-03-03', 'ide', N'copilot_app', 7),
          (@org, 1, '2026-03-03', 'ide', N'copilot_app', 7),
          (@org, 2, '2026-03-03', 'ide', N'copilot_app', 7),
          (@org, 3, '2026-03-03', 'ide', N'copilot_app', 7),
          (@org, 4, '2026-03-03', 'ide', N'copilot_app', 7),
          (@org, 0, '2026-03-04', 'feature', N'copilot_app', 0),
          (@org, 0, '2026-03-04', 'ide', N'copilot_app', 99),
          (@org, 0, '2026-03-05', 'feature', N'copilot_app', 0),
          (@org, 1, '2026-03-05', 'feature', N'copilot_app', 0),
          (@org, 2, '2026-03-05', 'feature', N'copilot_app', 0),
          (@org, 3, '2026-03-05', 'feature', N'copilot_app', 0),
          (@org, 4, '2026-03-05', 'feature', N'copilot_app', 0),
          (@org, 0, '2026-03-05', 'ide', N'copilot_app', 99),
          (@org, 0, '2026-03-07', 'ide', N'copilot_app', 0),
          (@org, 0, '2026-03-09', 'ide', N'copilot_app', 0),
          (@org, 1, '2026-03-09', 'ide', N'copilot_app', 0),
          (@org, 2, '2026-03-09', 'ide', N'copilot_app', 0),
          (@org, 3, '2026-03-09', 'ide', N'copilot_app', 0),
          (@org, 4, '2026-03-09', 'ide', N'copilot_app', 0),
          (@org + 1, 2, '2026-03-02', 'feature', N'copilot_app', 9000),
          (@org, 0, '2026-03-02', 'ide', N'vscode', 8),
          (@org, 1, '2026-03-02', 'ide', N'vscode', 8),
          (@org, 2, '2026-03-02', 'ide', N'vscode', 8),
          (@org, 3, '2026-03-02', 'ide', N'vscode', 8),
          (@org, 4, '2026-03-02', 'ide', N'vscode', 8)
        ) AS rows(org, n, day, kind, name, interactions);
      INSERT INTO portal.fact_usage_breakdown (
        organization_id, user_id, usage_day, breakdown_kind, key_1, key_2, interaction_count,
        code_generation_count, code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete,
        loc_added, loc_deleted, prompt_count, run_id, source_artifact_id, transform_version
      )
        SELECT org, @org + n, day, 'client', N'copilot_app', N'', 0, 0, 0, 0, 0, 0, 0,
          prompt_count, @run, @artifact, '1'
        FROM (VALUES
          (@org, 2, '2026-03-02', 9),
          (@org, 0, '2026-03-05', 13),
          (@org, 0, '2026-03-07', 2),
          (@org, 1, '2026-03-07', 0),
          (@org, 2, '2026-03-07', 3),
          (@org, 3, '2026-03-07', 2),
          (@org, 4, '2026-03-07', 3),
          (@org, 0, '2026-03-08', 2),
          (@org, 0, '2026-03-09', NULL),
          (@org, 1, '2026-03-09', NULL),
          (@org, 2, '2026-03-09', NULL),
          (@org, 3, '2026-03-09', NULL),
          (@org, 4, '2026-03-09', NULL),
          (@org, 0, '2026-03-11', NULL)
        ) AS prompt_rows(org, n, day, prompt_count);
      UPDATE portal.fact_user_daily_usage SET used_copilot_app = 1
        WHERE organization_id = @org AND usage_day = '2026-03-06';
    `);
  });
  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.close();
    }
  });

  it("overwrites raw App counts per authorized user/day, including zero features, without double counting", async () => {
    const result = await breakdown();
    expect(result).toEqual({
      rows: [
        { suppressed: false, userCount: 5, value: { kind: "ide", key: "copilot_app", interactions: 19, userCount: 5 } },
        { suppressed: false, userCount: 5, value: { kind: "ide", key: "vscode", interactions: 40, userCount: 5 } },
      ],
      totalItems: 2,
    });
  });

  it("preserves raw-only App and ordinary IDE rows, with default suppression for a one-user cohort", async () => {
    expect(await breakdown("2026-03-04")).toEqual({
      rows: [{ suppressed: true, userCount: null, value: null }], totalItems: 1,
    });
    expect((await breakdown("2026-03-03")).rows[0]?.value)
      .toEqual({ kind: "ide", key: "copilot_app", interactions: 35, userCount: 5 });
    expect((await breakdown()).rows[1]?.value)
      .toEqual({ kind: "ide", key: "vscode", interactions: 40, userCount: 5 });
  });

  it("keeps precedence at organization/user/day grain and counts distinct users across days", async () => {
    expect((await breakdown("2026-03-02", "2026-03-03")).rows[0]?.value)
      .toEqual({ kind: "ide", key: "copilot_app", interactions: 54, userCount: 5 });
    expect(await breakdown("2026-03-02", "2026-03-03", 2)).toEqual({ rows: [], totalItems: 2 });
    expect(await breakdown("2026-03-10")).toEqual({ rows: [], totalItems: 0 });
  });

  it("preserves an all-zero feature cohort as measured zero, rather than retaining raw counts or requiring an activation flag", async () => {
    expect(await breakdown("2026-03-05")).toEqual({
      rows: [{
        suppressed: false, userCount: 5,
        value: { kind: "ide", key: "copilot_app", interactions: 0, userCount: 5 },
      }], totalItems: 1,
    });
  });

  it("does not fabricate zero IDE interactions for flag/client-only days with unavailable prompt counts", async () => {
    expect(await breakdown("2026-03-06")).toEqual({ rows: [], totalItems: 0 });
  });

  it("does not synthesize App IDE rows from NULL prompt counts without raw activity", async () => {
    expect(await breakdown("2026-03-11")).toEqual({ rows: [], totalItems: 0 });
  });

  it("uses persisted prompt counts when features are absent and raw App interactions are missing or zero", async () => {
    expect(await breakdown("2026-03-07")).toEqual({
      rows: [{
        suppressed: false, userCount: 5,
        value: { kind: "ide", key: "copilot_app", interactions: 10, userCount: 5 },
      }], totalItems: 1,
    });
    expect(await breakdown("2026-03-08")).toEqual({
      rows: [{ suppressed: true, userCount: null, value: null }], totalItems: 1,
    });
    expect(await breakdown("2026-03-09")).toEqual({
      rows: [{
        suppressed: false, userCount: 5,
        value: { kind: "ide", key: "copilot_app", interactions: 0, userCount: 5 },
      }], totalItems: 1,
    });
  });

  it("does not expose feature-backed cohorts outside a real grant, even with organization narrowing", async () => {
    const result = await getUsageBreakdown(pool, { ...access, grants: [
      { role: "user", scope: "self", scope_value: "" },
    ] }, {
      from: "2026-03-02", to: "2026-03-02", organizationIds: [ORGANIZATION_ID],
      kind: "ide", page: 1, pageSize: 10,
    }, RUN_ID);
    expect(result.rows).toEqual([
      { suppressed: true, userCount: null, value: null },
      { suppressed: true, userCount: null, value: null },
    ]);
    const denied = await getUsageBreakdown(pool, { ...access, grants: [
      { role: "executive", scope: "department", scope_value: "no-such-department" },
    ] }, {
      from: "2026-03-02", to: "2026-03-02", organizationIds: [ORGANIZATION_ID],
      kind: "ide", page: 1, pageSize: 10,
    }, RUN_ID);
    expect(denied).toEqual({ rows: [], totalItems: 0 });
  });
});
