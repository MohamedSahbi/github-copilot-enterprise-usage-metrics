import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type sql from "mssql";
import {
  TEST_CURATED_PERSONAS,
  TEST_CURATED_EXPECTED_COUNTS,
  TEST_CURATED_RUN_IDS,
  type TestCuratedSeedResult,
} from "../stack/test-only-curated-seed";
import { loadLocalCuratedData } from "../stack/local-curated-data";
import { connectionString, openPool } from "./db";
import { AUTH_TENANT } from "./auth-seed";
import { SqlAccessRepository } from "../../portal/src/authz/sql-access";
import { resolveAccess } from "../../portal/src/authz/access";
import { readAccessSettings } from "../../portal/src/auth/settings";

let pool: sql.ConnectionPool;
let seedResult: TestCuratedSeedResult;

async function scalar(query: string, bind?: (request: sql.Request) => sql.Request): Promise<number> {
  const request = pool.request();
  const row = (await (bind ? bind(request) : request).query(query)).recordset[0] as { n: number };
  return Number(row.n);
}

describe("test-only curated seed (synthetic fixtures → curated)", () => {
  beforeAll(async () => {
    pool = await openPool();
    seedResult = await loadLocalCuratedData(connectionString);
  });

  afterAll(async () => {
    await pool.close();
  });

  it("reads usage and breakdown rows from the synthetic fixture into curated tables", async () => {
    expect(seedResult).toMatchObject({
      users: TEST_CURATED_EXPECTED_COUNTS.users,
      organizations: TEST_CURATED_EXPECTED_COUNTS.organizations,
      usageFacts: TEST_CURATED_EXPECTED_COUNTS.usageFacts,
      aiCreditFacts: TEST_CURATED_EXPECTED_COUNTS.aiCreditFacts,
    });
    expect(await scalar(
      "SELECT COUNT(*) AS n FROM portal.fact_user_daily_usage WHERE run_id = @run",
      (request) => request.input("run", TEST_CURATED_RUN_IDS.usage),
    )).toBe(seedResult.usageFacts);

    expect(await scalar(
      "SELECT COUNT(*) AS n FROM portal.fact_usage_breakdown WHERE run_id = @run",
      (request) => request.input("run", TEST_CURATED_RUN_IDS.usage),
    )).toBe(seedResult.breakdownFacts);
    expect(await scalar(
      "SELECT COUNT(*) AS n FROM portal.agg_daily_usage WHERE run_id = @run",
      (request) => request.input("run", TEST_CURATED_RUN_IDS.usage),
    )).toBe(seedResult.usageAggregates);
    expect(seedResult.familyFacts).toBeGreaterThan(0);

    const languageDimensions = await pool.request().query<{ language_key: string }>(
      "SELECT language_key FROM portal.dim_language ORDER BY language_key",
    );
    const languageAggregates = await pool.request()
      .input("run", TEST_CURATED_RUN_IDS.usage)
      .query<{ language_key: string; interactions: number }>(`
        SELECT group_key AS language_key, SUM(interaction_count) AS interactions
        FROM portal.agg_daily_usage
        WHERE run_id = @run AND group_kind = 'language'
        GROUP BY group_key ORDER BY group_key`);
    const languageFeatures = await pool.request()
      .input("run", TEST_CURATED_RUN_IDS.usage)
      .query<{ language_key: string; interactions: number }>(`
        SELECT key_1 AS language_key, SUM(interaction_count) AS interactions
        FROM portal.fact_usage_breakdown
        WHERE run_id = @run AND breakdown_kind = 'language_feature'
        GROUP BY key_1 ORDER BY key_1`);
    expect(languageAggregates.recordset.map((row) => row.language_key))
      .toEqual(languageDimensions.recordset.map((row) => row.language_key));
    expect(languageAggregates.recordset.map((row) => [row.language_key, Number(row.interactions)]))
      .toEqual(languageFeatures.recordset.map((row) => [row.language_key, Number(row.interactions)]));
    expect(await scalar(
      `SELECT COUNT(*) AS n FROM portal.agg_daily_usage
       WHERE run_id = @run AND group_kind = 'organization'
         AND (advanced_users <> 0 OR completion_only_users <> 0)`,
      (request) => request.input("run", TEST_CURATED_RUN_IDS.usage),
    )).toBe(0);
  });

  it("loads AI Credits fixture lines and aggregates", async () => {
    expect(await scalar(
      "SELECT COUNT(*) AS n FROM portal.fact_ai_credit_line WHERE run_id = @run",
      (request) => request.input("run", TEST_CURATED_RUN_IDS.aiCredits),
    )).toBe(seedResult.aiCreditFacts);
    expect(await scalar(
      "SELECT COUNT(*) AS n FROM portal.agg_ai_credit_daily WHERE run_id = @run",
      (request) => request.input("run", TEST_CURATED_RUN_IDS.aiCredits),
    )).toBe(seedResult.aiCreditAggregates);
  });

  it("provides company, team, self, and no-access grants for the four local personas", async () => {
    const scopes: Record<string, Array<{ role: string; scope: string }>> = {};
    for (const persona of Object.keys(TEST_CURATED_PERSONAS) as (keyof typeof TEST_CURATED_PERSONAS)[]) {
      const principalId = TEST_CURATED_PERSONAS[persona].principalId;
      const grants = await pool.request().input("principal", principalId).query<{ role: string; scope: string }>(
        "SELECT role, scope FROM portal.v_active_grant WHERE principal_id = @principal ORDER BY scope",
      );
      scopes[persona] = grants.recordset;
    }
    expect(scopes.admin).toEqual([{ role: "admin", scope: "company" }]);
    expect(scopes.manager).toEqual([{ role: "manager", scope: "team" }]);
    expect(scopes.member).toEqual([{ role: "user", scope: "self" }]);
    expect(scopes["no-access"]).toEqual([]);

    const freshSyncSources = await pool.request().query<{ source: string }>(`
      SELECT source FROM portal.DirectorySyncState
      WHERE source IN ('scim', 'graph', 'seats', 'csv')
        AND last_success_at >= DATEADD(MINUTE, -5, SYSUTCDATETIME())
      ORDER BY source`);
    expect(freshSyncSources.recordset.map((row) => row.source)).toEqual(["csv", "graph", "scim", "seats"]);

    const managerId = TEST_CURATED_PERSONAS.manager.userId;
    const teamCount = await scalar(
      `WITH team (user_id, entra_object_id) AS (
         SELECT user_id, entra_object_id FROM portal.dim_user WHERE user_id = @manager
         UNION ALL
         SELECT child.user_id, child.entra_object_id
         FROM portal.dim_user child JOIN team parent ON child.manager_entra_object_id = parent.entra_object_id
       )
       SELECT COUNT(*) AS n FROM team WHERE user_id <> @manager OPTION (MAXRECURSION 10)`,
      (request) => request.input("manager", managerId),
    );
    expect(teamCount).toBe(2);
    expect(await scalar(
      "SELECT COUNT(*) AS n FROM portal.dim_user WHERE user_id BETWEEN 1000001 AND 1000012 AND department = N'department-small'",
    )).toBe(2);
    expect(await scalar(
      "SELECT COUNT(*) AS n FROM portal.dim_user WHERE user_id BETWEEN 1000001 AND 1000012 AND business_area = N'business-area-small'",
    )).toBe(2);
    expect(await scalar(
      "SELECT COUNT(*) AS n FROM portal.dim_user WHERE user_id BETWEEN 1000001 AND 1000012",
    )).toBe(seedResult.users);
    expect(await scalar(
      "SELECT COUNT(*) AS n FROM portal.dim_organization WHERE organization_id IN (9000001, 9000002)",
    )).toBe(seedResult.organizations);

    const adminData = await scalar(
      "SELECT COUNT(DISTINCT user_id) AS n FROM portal.fact_user_daily_usage WHERE run_id = @run",
      (request) => request.input("run", TEST_CURATED_RUN_IDS.usage),
    );
    const memberData = await scalar(
      "SELECT COUNT(DISTINCT user_id) AS n FROM portal.fact_user_daily_usage WHERE run_id = @run AND user_id = @user",
      (request) => request.input("run", TEST_CURATED_RUN_IDS.usage).input("user", TEST_CURATED_PERSONAS.member.userId),
    );
    expect(adminData).toBe(TEST_CURATED_EXPECTED_COUNTS.users);
    expect(memberData).toBe(1);
  });

  it("resolves each seeded E2E persona through the SQL-backed access model", async () => {
    const repository = new SqlAccessRepository(pool);
    const expectedState = {
      admin: "authorized",
      manager: "authorized",
      member: "authorized",
      "no-access": "no-access",
    } as const;
    const expectedGrants = {
      admin: [{ role: "admin", scope: "company" }],
      manager: [{ role: "manager", scope: "team" }],
      member: [{ role: "user", scope: "self" }],
      "no-access": [],
    } as const;

    const personaIds = Object.keys(TEST_CURATED_PERSONAS) as (keyof typeof TEST_CURATED_PERSONAS)[];
    for (const personaId of personaIds) {
      const persona = TEST_CURATED_PERSONAS[personaId];
      const mappedUser = await pool.request()
        .input("userId", persona.userId)
        .input("entraObjectId", persona.entraObjectId)
        .query<{ user_id: number }>(`
          SELECT user_id FROM portal.dim_user
          WHERE user_id = @userId AND entra_object_id = @entraObjectId`);
      expect(mappedUser.recordset).toHaveLength(1);

      const principal = await pool.request()
        .input("principalId", persona.principalId)
        .input("tenantId", AUTH_TENANT)
        .input("entraObjectId", persona.entraObjectId)
        .query<{ principal_id: string }>(`
          SELECT principal_id FROM portal.Principal
          WHERE principal_id = @principalId AND entra_tenant_id = @tenantId AND entra_object_id = @entraObjectId`);
      expect(principal.recordset).toHaveLength(1);

      const access = await resolveAccess({
        provider: "entra",
        tenantId: AUTH_TENANT,
        objectId: persona.entraObjectId,
        groups: [],
      }, repository, readAccessSettings({}));

      expect(access.state, personaId).toBe(expectedState[personaId]);
      if (access.state === "authorized") {
        expect(access.principal).toMatchObject({
          principal_id: persona.principalId,
          entra_tenant_id: AUTH_TENANT,
          entra_object_id: persona.entraObjectId,
        });
        expect(access.grants.map(({ role, scope }) => ({ role, scope })))
          .toEqual(expectedGrants[personaId]);
      }
    }
  });
});
