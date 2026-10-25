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
    expect(scopes.manager).toEqual([{ role: "manager", scope: "self" }, { role: "manager", scope: "team" }]);
    expect(scopes.member).toEqual([{ role: "user", scope: "self" }]);
    expect(scopes["no-access"]).toEqual([]);

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
});
