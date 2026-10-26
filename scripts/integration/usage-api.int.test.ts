import sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Scope } from "../../shared/src/rows";
import { getUsageBreakdown, getUsageOverview, getUserUsage, resolveUsageRange } from "../../portal/src/usage/sql-usage";
import type { AuthorizedUsageAccess } from "../../portal/src/usage/api";
import { openPool } from "./db";

const ORGANIZATION_ID = 990087001;
const USER_IDS = [990087001, 990087002, 990087003, 990087004, 990087005, 990087006, 990087007];
const OBJECT_IDS = USER_IDS.map((_, index) => `00000000-0000-4000-8000-${String(8701 + index).padStart(12, "0")}`);
const TENANT_ID = "00000000-0000-4000-8000-000000000087";
const RUN_ID = "00000000-0000-4000-8000-000000000087";
const CORRELATION_ID = RUN_ID;
const DAY = "2026-03-02";
const PREVIOUS_DAY = "2026-03-01";
const MAX_SOURCE_CREDITS = "999999999.999999999";
const RANGE = { from: DAY, to: DAY, organizationIds: [ORGANIZATION_ID] };

let pool: sql.ConnectionPool;

function accessFor(
  objectId: string,
  grants: { role: "user" | "manager" | "executive" | "admin"; scope: Scope; scope_value: string }[],
  namesVisible = true,
): AuthorizedUsageAccess {
  return {
    state: "authorized",
    breakGlass: false,
    principal: {
      principal_id: TENANT_ID,
      entra_tenant_id: TENANT_ID,
      entra_object_id: objectId,
      github_user_id: null,
      status: "active",
    },
    grants,
    namesVisible,
  };
}

async function cleanup(): Promise<void> {
  await pool.request().input("organizationId", sql.BigInt, ORGANIZATION_ID)
    .query("DELETE FROM portal.fact_usage_breakdown WHERE organization_id = @organizationId");
  await pool.request().input("organizationId", sql.BigInt, ORGANIZATION_ID)
    .query("DELETE FROM portal.fact_user_daily_usage WHERE organization_id = @organizationId");
  await pool.request().input("organizationId", sql.BigInt, ORGANIZATION_ID)
    .query("DELETE FROM portal.dim_user WHERE user_id BETWEEN @organizationId AND @organizationId + 6");
  await pool.request().input("organizationId", sql.BigInt, ORGANIZATION_ID)
    .query("DELETE FROM portal.dim_organization WHERE organization_id = @organizationId");
  await pool.request().input("runId", sql.UniqueIdentifier, RUN_ID)
    .query("DELETE FROM portal.SourceArtifact WHERE run_id = @runId");
  await pool.request().input("runId", sql.UniqueIdentifier, RUN_ID)
    .query("DELETE FROM portal.IngestionRun WHERE run_id = @runId");
}

async function seed(): Promise<void> {
  await pool.request().input("runId", sql.UniqueIdentifier, RUN_ID).input("day", sql.Date, new Date(`${DAY}T00:00:00Z`))
    .query(`INSERT INTO portal.IngestionRun (run_id, source_kind, scope_key, report_day, status, is_current, transform_version)
      VALUES (@runId, 'users_1_day', 'usage-api-integration', @day, 'published', 0, '1')`);
  const artifactResult = await pool.request().input("runId", sql.UniqueIdentifier, RUN_ID)
    .query<{ artifact_id: number }>(`INSERT INTO portal.SourceArtifact (run_id, blob_container, blob_path, sha256, size_bytes)
      OUTPUT INSERTED.artifact_id AS artifact_id
      VALUES (@runId, 'raw', 'integration/usage-api.ndjson', REPLICATE('a', 64), 1)`);
  const artifactId = artifactResult.recordset[0]!.artifact_id;
  await pool.request().input("organizationId", sql.BigInt, ORGANIZATION_ID)
    .query("INSERT INTO portal.dim_organization (organization_id, login) VALUES (@organizationId, 'usage-api-integration')");

  for (let index = 0; index < USER_IDS.length; index++) {
    const userId = USER_IDS[index]!;
    const objectId = OBJECT_IDS[index]!;
    const manager = index === 1 || index === 2 ? OBJECT_IDS[0]! : index === 3 ? OBJECT_IDS[1]! : index === 4 ? OBJECT_IDS[3]! : null;
    const department = index < 5 ? "engineering" : "sales";
    const businessArea = index < 5 ? "platform" : "sales";
    await pool.request().input("userId", sql.BigInt, userId)
      .input("objectId", sql.UniqueIdentifier, objectId)
      .input("managerObjectId", sql.UniqueIdentifier, manager)
      .input("department", sql.NVarChar(100), department)
      .input("businessArea", sql.NVarChar(50), businessArea)
      .query(`INSERT INTO portal.dim_user (user_id, login, entra_object_id, manager_entra_object_id, manager_email, department, business_area, state)
        VALUES (@userId, CONCAT('usage-user-', @userId), @objectId, @managerObjectId,
          CASE WHEN @managerObjectId IS NULL THEN NULL ELSE N'manager@example.invalid' END,
          @department, @businessArea, 'active')`);
    await pool.request().input("organizationId", sql.BigInt, ORGANIZATION_ID)
      .input("userId", sql.BigInt, userId)
      .input("day", sql.Date, new Date(`${DAY}T00:00:00Z`))
      .input("runId", sql.UniqueIdentifier, RUN_ID)
      .input("artifactId", sql.BigInt, artifactId)
      .input("aiCreditsUsed", sql.VarChar(40), index === 0 ? MAX_SOURCE_CREDITS : "0.5")
      .query(`INSERT INTO portal.fact_user_daily_usage (
          organization_id, user_id, usage_day, interaction_count, code_generation_count, code_acceptance_count,
          loc_suggested_to_add, loc_suggested_to_delete, loc_added, loc_deleted, used_agent, used_chat, used_cli,
          used_coding_agent, used_cloud_agent, used_copilot_app, used_vscode_agent, used_code_review_active,
          used_code_review_passive, ai_credits_used, run_id, source_artifact_id, transform_version
        ) VALUES (@organizationId, @userId, @day, 2, 1, 1, 2, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, CAST(@aiCreditsUsed AS DECIMAL(18,9)),
          @runId, @artifactId, '1')`);
    await pool.request().input("organizationId", sql.BigInt, ORGANIZATION_ID)
      .input("userId", sql.BigInt, userId)
      .input("day", sql.Date, new Date(`${DAY}T00:00:00Z`))
      .input("runId", sql.UniqueIdentifier, RUN_ID)
      .input("artifactId", sql.BigInt, artifactId)
      .query(`INSERT INTO portal.fact_usage_breakdown (
          organization_id, user_id, usage_day, breakdown_kind, key_1, key_2, interaction_count,
          code_generation_count, code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete,
          loc_added, loc_deleted, run_id, source_artifact_id, transform_version
        ) VALUES (@organizationId, @userId, @day, 'feature', N'code_completion', N'', 2, 1, 1, 2, 0,
          2, 0, @runId, @artifactId, '1')`);
    if (index === 1) {
      await pool.request().input("organizationId", sql.BigInt, ORGANIZATION_ID)
        .input("userId", sql.BigInt, userId)
        .input("day", sql.Date, new Date(`${DAY}T00:00:00Z`))
        .input("runId", sql.UniqueIdentifier, RUN_ID)
        .input("artifactId", sql.BigInt, artifactId)
        .query(`INSERT INTO portal.fact_usage_breakdown (
            organization_id, user_id, usage_day, breakdown_kind, key_1, key_2, interaction_count,
            code_generation_count, code_acceptance_count, loc_suggested_to_add, loc_suggested_to_delete,
            loc_added, loc_deleted, run_id, source_artifact_id, transform_version
          ) VALUES (@organizationId, @userId, @day, 'feature', N'chat_panel_ask_mode', N'', 1, 0, 0, 0, 0,
            0, 0, @runId, @artifactId, '1')`);
    }
  }

  const previousDay = new Date(`${PREVIOUS_DAY}T00:00:00Z`);
  await pool.request().input("organizationId", sql.BigInt, ORGANIZATION_ID)
    .input("userId", sql.BigInt, USER_IDS[0]!)
    .input("day", sql.Date, previousDay)
    .input("runId", sql.UniqueIdentifier, RUN_ID)
    .input("artifactId", sql.BigInt, artifactId)
    .input("aiCreditsUsed", sql.VarChar(40), MAX_SOURCE_CREDITS)
    .query(`INSERT INTO portal.fact_user_daily_usage (
      organization_id, user_id, usage_day, interaction_count, code_generation_count, code_acceptance_count,
      loc_suggested_to_add, loc_suggested_to_delete, loc_added, loc_deleted, used_agent, used_chat, used_cli,
      used_coding_agent, used_cloud_agent, used_copilot_app, used_vscode_agent, used_code_review_active,
      used_code_review_passive, ai_credits_used, run_id, source_artifact_id, transform_version
    ) VALUES (@organizationId, @userId, @day, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, CAST(@aiCreditsUsed AS DECIMAL(18,9)),
      @runId, @artifactId, '1')`);
}

describe("scoped usage API SQL (curated integration)", () => {
  beforeAll(async () => {
    pool = await openPool();
    await cleanup();
    await seed();
  });
  afterAll(async () => {
    await cleanup();
    await pool.close();
  });

  it.each([
    ["user", "self", OBJECT_IDS[1]!, "", [USER_IDS[1]!]],
    ["manager", "self", OBJECT_IDS[0]!, "", [USER_IDS[0]!]],
    ["manager", "team", OBJECT_IDS[0]!, "", USER_IDS.slice(1, 5)],
    ["executive", "department", OBJECT_IDS[0]!, "engineering", USER_IDS.slice(0, 5)],
    ["executive", "business_area", OBJECT_IDS[0]!, "sales", USER_IDS.slice(5)],
    ["executive", "company", OBJECT_IDS[0]!, "", USER_IDS],
    ["admin", "company", OBJECT_IDS[0]!, "", USER_IDS],
  ] as const)("enforces the %s/%s persona-scope grant without cross-scope users", async (role, scope, objectId, scopeValue, expectedUserIds) => {
    const result = await getUserUsage(pool, accessFor(objectId, [
      { role, scope, scope_value: scopeValue },
    ]), { ...RANGE, page: 1, pageSize: 50 }, CORRELATION_ID);

    expect(result.rows.map((row) => row.userId)).toEqual(expectedUserIds);
  });

  it.each([
    ["last_7_days", 7],
    ["last_28_days", 28],
    ["last_90_days", 90],
  ] as const)("resolves %s against the latest curated usage day", async (period, days) => {
    const latestResult = await pool.request().query<{ latestUsageDay: Date | null }>(`
      SELECT MAX(usage_day) AS latestUsageDay
      FROM portal.fact_user_daily_usage
    `);
    const latestUsageDay = latestResult.recordset[0]?.latestUsageDay;
    if (!latestUsageDay) throw new Error("Expected curated usage fixtures to contain a usage day");

    const to = latestUsageDay.toISOString().slice(0, 10);
    const expectedFrom = new Date(`${to}T00:00:00.000Z`);
    expectedFrom.setUTCDate(expectedFrom.getUTCDate() - days + 1);
    const from = expectedFrom.toISOString().slice(0, 10);
    const resolved = await resolveUsageRange(pool, { period });
    expect(resolved).toEqual({ ok: true, range: { from, to } });
  });

  it("resolves only complete calendar months against the latest curated usage day", async () => {
    expect(await resolveUsageRange(pool, { period: "calendar_month", month: "2026-02" }))
      .toEqual({ ok: true, range: { from: "2026-02-01", to: "2026-02-28" } });
    expect(await resolveUsageRange(pool, { period: "calendar_month", month: "2026-03" }))
      .toEqual({ ok: false });
  });

  it.each([false, true])("suppresses groups below five with per-user detail enabled=%s", async (namesVisible) => {
    const team = await getUsageOverview(pool, accessFor(OBJECT_IDS[0]!, [
      { role: "manager", scope: "team", scope_value: "" },
    ], namesVisible), RANGE, CORRELATION_ID);
    expect(team.series[0]).toMatchObject({ suppressed: true, userCount: null, value: null });

    const department = await getUsageOverview(pool, accessFor(OBJECT_IDS[0]!, [
      { role: "executive", scope: "department", scope_value: "engineering" },
    ], namesVisible), RANGE, CORRELATION_ID);
    expect(department.series[0]).toMatchObject({
      suppressed: false,
      userCount: 5,
      value: { activeUsers: 5 },
    });
    expect(department.adoption).toMatchObject({ suppressed: false, userCount: 5 });
  });

  it("returns aggregate breakdowns and paged per-user rows only from the authorized subset", async () => {
    const departmentAccess = accessFor(OBJECT_IDS[0]!, [
      { role: "executive", scope: "department", scope_value: "engineering" },
    ]);
    const breakdown = await getUsageBreakdown(pool, departmentAccess, {
      ...RANGE,
      kind: "feature",
      page: 1,
      pageSize: 10,
    }, CORRELATION_ID);
    expect(breakdown.totalItems).toBe(2);
    expect(breakdown.rows.find((row) => row.value?.key === "code_completion")).toMatchObject({
      suppressed: false,
      userCount: 5,
      value: { interactions: 10 },
    });
    expect(breakdown.rows.filter((row) => row.suppressed)).toHaveLength(1);
    expect(breakdown.rows.find((row) => row.suppressed)).toMatchObject({
      suppressed: true,
      userCount: null,
      value: null,
    });
    const emptyBreakdownPage = await getUsageBreakdown(pool, departmentAccess, {
      ...RANGE,
      kind: "feature",
      page: 10,
      pageSize: 10,
    }, CORRELATION_ID);
    expect(emptyBreakdownPage).toMatchObject({ rows: [], totalItems: 2 });

    const teamAccess = accessFor(OBJECT_IDS[0]!, [
      { role: "manager", scope: "team", scope_value: "" },
    ]);
    const users = await getUserUsage(pool, teamAccess, { ...RANGE, page: 1, pageSize: 2 }, CORRELATION_ID);
    expect(users.rows.map((row) => row.userId)).toEqual(USER_IDS.slice(1, 3));
    expect(users.totalItems).toBe(4);
    const emptyUsersPage = await getUserUsage(pool, teamAccess, { ...RANGE, page: 10, pageSize: 2 }, CORRELATION_ID);
    expect(emptyUsersPage).toMatchObject({ rows: [], totalItems: 4 });
  });

  it("preserves an actual SQL DECIMAL(38,9) user sum as exact text through the mssql driver", async () => {
    const driverProbe = await pool.request().query<{ aggregate: number; exactText: string }>(`
      WITH Input(v) AS (
        SELECT CAST(999999999.999999999 AS DECIMAL(18,9))
        UNION ALL
        SELECT CAST(999999999.999999999 AS DECIMAL(18,9))
      )
      SELECT SUM(v) AS aggregate,
        CONVERT(VARCHAR(40), SUM(v)) AS exactText
      FROM Input
    `);
    expect(driverProbe.recordset[0]?.aggregate).toBe(2_000_000_000);
    expect(driverProbe.recordset[0]?.exactText).toBe("1999999999.999999998");

    const usage = await getUserUsage(pool, accessFor(OBJECT_IDS[0]!, [
      { role: "user", scope: "self", scope_value: "" },
    ]), {
      from: PREVIOUS_DAY,
      to: DAY,
      organizationIds: [ORGANIZATION_ID],
      page: 1,
      pageSize: 10,
    }, CORRELATION_ID);
    expect(usage.rows[0]?.aiCreditsUsed).toBe("1999999999.999999998");
    expect(typeof usage.rows[0]?.aiCreditsUsed).toBe("string");
  });
});
