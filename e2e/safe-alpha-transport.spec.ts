import sql from "mssql";
import { mkdir } from "node:fs/promises";
import { expect, expectNoAxeViolations, test } from "./fixtures";
import { openPool } from "../scripts/integration/db";
import { AUTH_PRINCIPALS_BY_PERSONA, AUTH_OBJECTS_BY_PERSONA, AUTH_TENANT } from "../scripts/integration/auth-seed";
import { TEST_CURATED_RUN_IDS } from "../scripts/stack/test-only-curated-seed";
import { getUsageOverview } from "../portal/src/usage/sql-usage";
import { SqlAccessRepository } from "../portal/src/authz/sql-access";
import { resolveAccess } from "../portal/src/authz/access";
import { readAccessSettings } from "../portal/src/auth/settings";
import { assertExplicitLocalConnection } from "../scripts/stack/config";

const flightVariants: { name: string; headers: Record<string, string> }[] = [
  { name: "rsc", headers: { RSC: "1" } },
  {
    name: "navigation",
    headers: {
      RSC: "1",
      "Next-Router-State-Tree": encodeURIComponent(JSON.stringify(["", { children: ["__PAGE__", {}] }, null, "refetch"])),
      "Next-Url": "/",
    },
  },
  {
    name: "prefetch",
    headers: { RSC: "1", "Next-Router-Prefetch": "1", "Next-Url": "/" },
  },
];
// Next.js may prefetch only the layout tree; full RSC/navigation must carry the page or denial digest.
const excludedPaths = [
  "/executive-summary", "/executivesummary", "/copilot-adoption", "/languages", "/model-usage",
  "/cli-adoption", "/clients", "/client-versions", "/ai-adoption-phases", "/users",
  "/poc/feature-adoption", "/users/1000001",
];
const privateKeys = /"(?:adoption|completionUsers|completionOnlyUsers|chatUsers|agentModeUsers|askModeUsers|inlineModeUsers|planModeUsers|cliUsers|appUsers|vscodeAgentUsers|codingAgentUsers|codeReviewUsers|advancedUsers|userCount|suppressed|breakdowns|allowedUserIds|userIds)"\s*:/;

function expectSafePayload(payload: string) {
  expect(payload.replaceAll('\\"', '"')).not.toMatch(privateKeys);
}

async function ownedFixturePool() {
  assertExplicitLocalConnection(process.env);
  const pool = await openPool();
  try {
    const database = await pool.request().query<{ databaseName: string }>("SELECT DB_NAME() AS databaseName");
    expect(database.recordset).toEqual([{ databaseName: "portal_local" }]);
    const seeded = await pool.request().input("run", sql.UniqueIdentifier, TEST_CURATED_RUN_IDS.usage)
      .query<{ facts: number }>("SELECT COUNT(*) AS facts FROM portal.fact_user_daily_usage WHERE run_id = @run");
    expect(seeded.recordset).toEqual([{ facts: 45 }]);
    return pool;
  } catch (error) {
    await pool.close();
    throw error;
  }
}

test.describe("Safe Alpha standalone Flight transport", () => {
  test.describe.configure({ mode: "serial" });

  test("released Flight variants omit private fields and excluded routes deny every Flight variant", async ({ page, signInAs }, testInfo) => {
    await signInAs("admin");
    for (const variant of flightVariants) {
      for (const path of ["/", "/copilot-impact"]) {
        const response = await page.request.get(path, { headers: variant.headers });
        expect(response.status(), `${variant.name} ${path}`).toBe(200);
        expect(response.headers()["content-type"]).toContain("text/x-component");
        const payload = await response.text();
        await testInfo.attach(`${variant.name}-${path === "/" ? "overview" : "impact"}.flight`, {
          body: payload, contentType: "text/plain",
        });
        if (variant.name !== "prefetch") {
          expect(payload).toContain(path === "/" ? "Daily usage overview" : "Daily Copilot impact");
        }
        expectSafePayload(payload);
      }
      for (const path of excludedPaths) {
        const response = await page.request.get(path, { headers: variant.headers });
        const payload = await response.text();
        await testInfo.attach(`${variant.name}-${path.replaceAll("/", "-")}.flight`, {
          body: JSON.stringify({ status: response.status(), body: payload }), contentType: "application/json",
        });
        expect(response.headers()["content-type"], `${variant.name} ${path}`).toContain("text/x-component");
        // Next.js can stream the not-found digest after sending a 200 Flight header.
        expect([200, 404], `${variant.name} ${path}`).toContain(response.status());
        if (variant.name !== "prefetch") expect(payload).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
        expect(payload).not.toMatch(/Daily usage overview|Daily Copilot impact|Feature Adoption Funnel/);
        expectSafePayload(payload);
      }
      for (const scope of ["", "team:team-1", "department:stale", "all:all&scope=all:all"]) {
        const query = scope.includes("&") ? scope : encodeURIComponent(scope);
        const response = await page.request.get(`/?scope=${query}`, { headers: variant.headers });
        const payload = await response.text();
        if (variant.name !== "prefetch") expect(payload).toContain("NEXT_HTTP_ERROR_FALLBACK;404");
        expect(payload).not.toContain("Daily usage overview");
      }
      for (const path of ["/api/usage/overview?period=invalid", "/api/usage/breakdown?kind=invalid", "/api/users?page=0"]) {
        const response = await page.request.get(path, { headers: variant.headers });
        expect(response.status()).toBe(404);
        expect(response.headers()["cache-control"]).toBe("private, no-store");
        expect(response.headers()["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/i);
        expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
      }
    }
  });

  test("five-user parent with child counts one through four never serializes children over HTML or Flight", async ({
    page, signInAs, consoleErrors,
  }, testInfo) => {
    const pool = await ownedFixturePool();
    type Snapshot = {
      organization_id: number;
      user_id: number;
      usage_day: Date;
      used_cli: boolean;
      used_copilot_app: boolean;
      used_vscode_agent: boolean;
      used_cloud_agent: boolean;
      used_code_review_active: boolean;
      used_code_review_passive: boolean;
    };
    const original = (await pool.request().input("run", sql.UniqueIdentifier, TEST_CURATED_RUN_IDS.usage)
      .query<Snapshot>(`SELECT organization_id, user_id, usage_day, used_cli, used_copilot_app,
        used_vscode_agent, used_cloud_agent, used_code_review_active, used_code_review_passive
        FROM portal.fact_user_daily_usage WHERE run_id = @run ORDER BY organization_id, usage_day, user_id`)).recordset;
    type FixtureKey = { organization_id: number; user_id: number; usage_day: Date };
    let fixtureDay: Date | undefined;
    let sourceKeys: FixtureKey[] = [];
    let inserted = false;
    try {
      const dates = await pool.request().input("run", sql.UniqueIdentifier, TEST_CURATED_RUN_IDS.usage)
        .query<{ day: Date }>("SELECT DATEADD(day, 7, MAX(usage_day)) AS day FROM portal.fact_user_daily_usage WHERE run_id = @run");
      fixtureDay = dates.recordset[0]!.day;
      const day = fixtureDay.toISOString().slice(0, 10);
      sourceKeys = (await pool.request().input("run", sql.UniqueIdentifier, TEST_CURATED_RUN_IDS.usage)
        .input("day", sql.Date, fixtureDay).query<FixtureKey>(`
          SELECT organization_id, user_id, usage_day FROM portal.fact_user_daily_usage
          WHERE run_id = @run AND usage_day = DATEADD(day, -7, @day)
            AND user_id IN (1000001, 1000003, 1000007, 1000009, 1000011)
          ORDER BY organization_id, user_id
        `)).recordset;
      expect(sourceKeys).toHaveLength(5);
      expect(sourceKeys.map(({ user_id }) => Number(user_id)).sort((a, b) => a - b))
        .toEqual([1000001, 1000003, 1000007, 1000009, 1000011]);
      const destination = await pool.request().input("day", sql.Date, fixtureDay).query<{ rows: number }>(
        "SELECT COUNT(*) AS rows FROM portal.fact_user_daily_usage WHERE usage_day = @day",
      );
      expect(destination.recordset).toEqual([{ rows: 0 }]);
      const changed = await pool.request().input("run", sql.UniqueIdentifier, TEST_CURATED_RUN_IDS.usage)
        .input("keys", sql.NVarChar(sql.MAX), JSON.stringify(sourceKeys))
        .input("day", sql.Date, fixtureDay).query(`
          INSERT INTO portal.fact_user_daily_usage (
            organization_id, user_id, usage_day, interaction_count, code_generation_count, code_acceptance_count,
            loc_suggested_to_add, loc_suggested_to_delete, loc_added, loc_deleted,
            used_agent, used_chat, used_cli, used_coding_agent, used_cloud_agent, used_copilot_app,
            used_vscode_agent, used_code_review_active, used_code_review_passive, ai_credits_used,
            ai_adoption_phase_number, ai_adoption_phase, extra_json, run_id, source_artifact_id, transform_version
          )
          SELECT organization_id, user_id, @day, interaction_count, code_generation_count, code_acceptance_count,
            loc_suggested_to_add, loc_suggested_to_delete, loc_added, loc_deleted,
            used_agent, used_chat, CASE WHEN user_id = 1000001 THEN 1 ELSE 0 END, used_coding_agent,
            CASE WHEN user_id IN (1000001, 1000003, 1000007, 1000009) THEN 1 ELSE 0 END,
            CASE WHEN user_id IN (1000001, 1000003) THEN 1 ELSE 0 END,
            CASE WHEN user_id IN (1000001, 1000003, 1000007) THEN 1 ELSE 0 END,
            1, 0, ai_credits_used, ai_adoption_phase_number, ai_adoption_phase, extra_json,
            run_id, source_artifact_id, transform_version
          FROM portal.fact_user_daily_usage f
          WHERE run_id = @run AND EXISTS (
            SELECT 1 FROM OPENJSON(@keys) WITH (organization_id BIGINT, user_id BIGINT, usage_day DATETIME2) k
            WHERE k.organization_id = f.organization_id AND k.user_id = f.user_id AND k.usage_day = f.usage_day
          )
        `);
      inserted = true;
      expect(changed.rowsAffected).toEqual([5]);
      const access = await resolveAccess(
        { provider: "entra", tenantId: AUTH_TENANT, objectId: AUTH_OBJECTS_BY_PERSONA.admin, groups: [] },
        new SqlAccessRepository(pool),
        readAccessSettings({}),
      );
      if (access.state !== "authorized") throw new Error("Synthetic admin was not authorized");
      const internal = await getUsageOverview(pool, access, { from: day, to: day }, "00000000-0000-4000-8000-000000000115");
      expect(internal.adoption.suppressed).toBe(false);
      expect(internal.adoption.value).toMatchObject({
        totalUsers: 5, cliUsers: 1, appUsers: 2, vscodeAgentUsers: 3, codingAgentUsers: 4,
      });
      expect(internal.series).toHaveLength(1);
      const daily = internal.series[0]?.value;
      if (!daily) throw new Error("Expected a visible synthetic five-user daily row");
      expect(daily.activeUsers).toBe(5);
      console.log("five-user fixture: derived rows=5 parent=5 children=1,2,3,4 visibleDays=1");

      await signInAs("admin");
      for (const path of ["/", "/copilot-impact"]) {
        const response = await page.goto(path);
        if (!response) throw new Error("Missing document response");
        expect(response.status()).toBe(200);
        expectSafePayload(await response.text());
        await expect(page.getByRole("row")).toHaveCount(2);
        if (path === "/") {
          await expect(page.getByRole("definition")).toHaveText("5");
          await expect(page.getByRole("cell", { name: String(daily.interactions), exact: true })).toBeVisible();
        }
        await expectNoAxeViolations(page);
        await mkdir("test-results/screenshots", { recursive: true });
        await page.screenshot({ path: `test-results/screenshots/five-user-${path === "/" ? "overview" : "impact"}.png`, fullPage: true });
        for (const variant of flightVariants) {
          const flight = await page.request.get(path, { headers: variant.headers });
          expect(flight.status()).toBe(200);
          expect(flight.headers()["content-type"]).toContain("text/x-component");
          const payload = await flight.text();
          await testInfo.attach(`five-user-${variant.name}-${path === "/" ? "overview" : "impact"}.flight`, {
            body: payload, contentType: "text/plain",
          });
          expectSafePayload(payload);
          if (variant.name !== "prefetch") {
            expect(payload).toContain(path === "/" ? "Observed users" : "Daily Copilot impact");
            expect(payload).toContain(String(path === "/" ? daily.interactions : daily.codeGenerations));
          }
        }
      }
      expect(consoleErrors).toEqual([]);
      for (const persona of ["manager", "member"] as const) {
        await signInAs(persona);
        await expect(page.getByRole("row")).toHaveCount(1);
        await expect(page.getByText(
          "Metrics may be limited by the deployment's minimum-group privacy controls.", { exact: true },
        )).toHaveCount(1);
        for (const variant of flightVariants) {
          const response = await page.request.get("/", { headers: variant.headers });
          expect(response.status()).toBe(200);
          expect(response.headers()["content-type"]).toContain("text/x-component");
          const payload = await response.text();
          await testInfo.attach(`${persona}-${variant.name}.flight`, { body: payload, contentType: "text/plain" });
          expectSafePayload(payload);
          expect(payload).not.toContain("Observed users");
          if (variant.name !== "prefetch") {
            expect(payload).toContain("Metrics may be limited by the deployment's minimum-group privacy controls.");
          }
        }
        await expectNoAxeViolations(page);
      }
      expect(consoleErrors).toEqual([]);
    } finally {
      try {
        if (inserted && fixtureDay) {
          const restored = await pool.request().input("day", sql.Date, fixtureDay)
            .input("keys", sql.NVarChar(sql.MAX), JSON.stringify(sourceKeys))
            .input("run", sql.UniqueIdentifier, TEST_CURATED_RUN_IDS.usage).query(`DELETE FROM portal.fact_user_daily_usage
              WHERE run_id = @run AND usage_day = @day AND EXISTS (
                SELECT 1 FROM OPENJSON(@keys) WITH (organization_id BIGINT, user_id BIGINT, usage_day DATETIME2) k
                WHERE k.organization_id = portal.fact_user_daily_usage.organization_id
                  AND k.user_id = portal.fact_user_daily_usage.user_id
                  AND DATEADD(day, 7, k.usage_day) = portal.fact_user_daily_usage.usage_day
              )`);
          expect(restored.rowsAffected).toEqual([5]);
          const verified = await pool.request().input("run", sql.UniqueIdentifier, TEST_CURATED_RUN_IDS.usage)
            .query<Snapshot>(`SELECT organization_id, user_id, usage_day, used_cli, used_copilot_app,
                used_vscode_agent, used_cloud_agent, used_code_review_active, used_code_review_passive
              FROM portal.fact_user_daily_usage WHERE run_id = @run ORDER BY organization_id, usage_day, user_id`);
          expect(verified.recordset).toEqual(original);
          console.log("five-user fixture: removed derived rows=5, original 45 rows and values verified");
        }
      } finally { await pool.close(); }
    }
  });

  test("revoked SQL grant denies the next authenticated HTML, Flight and API requests without stale access", async ({ page, signInAs }, testInfo) => {
    const pool = await ownedFixturePool();
    let grantId: string | undefined;
    try {
      await signInAs("manager");
      expect((await page.request.get("/")).status()).toBe(200);
      const active = await pool.request().input("principal", sql.UniqueIdentifier, AUTH_PRINCIPALS_BY_PERSONA.manager)
        .query<{ grantId: string }>("SELECT CONVERT(VARCHAR(20), grant_id) AS grantId FROM portal.v_active_grant WHERE principal_id = @principal AND role = 'manager' AND scope = 'team'");
      expect(active.recordset).toHaveLength(1);
      grantId = active.recordset[0]!.grantId;
      const revoked = await pool.request().input("grant", sql.BigInt, grantId)
        .input("principal", sql.UniqueIdentifier, AUTH_PRINCIPALS_BY_PERSONA.manager)
        .query("UPDATE portal.AccessGrant SET revoked_at = SYSUTCDATETIME() WHERE grant_id = @grant AND principal_id = @principal AND revoked_at IS NULL");
      expect(revoked.rowsAffected).toEqual([1]);
      for (const { name, headers } of [{ name: "document", headers: {} }, ...flightVariants]) {
        let response = await page.request.get("/", { headers, maxRedirects: 0 });
        if (response.status() === 307 && response.headers().location?.startsWith("/?")) {
          const original = new URL(response.url());
          const normalized = new URL(response.headers().location!, original);
          expect(normalized.origin).toBe(original.origin);
          expect(normalized.pathname).toBe(original.pathname);
          expect(normalized.hash).toBe("");
          expect(normalized.searchParams.getAll("_rsc")).toHaveLength(1);
          normalized.searchParams.delete("_rsc");
          expect(normalized.search).toBe(original.search);
          expect(await response.text()).toBe("");
          await testInfo.attach(`revoked-${name}-normalization.json`, {
            body: JSON.stringify({ url: response.url(), status: 307, location: response.headers().location }),
            contentType: "application/json",
          });
          response = await page.request.get(new URL(response.headers().location!, original).href, { headers, maxRedirects: 0 });
        }
        const payload = await response.text();
        await testInfo.attach(`revoked-${Object.keys(headers).join("-") || "document"}.txt`, {
          body: JSON.stringify({ status: response.status(), location: response.headers().location, body: payload }),
          contentType: "application/json",
        });
        expect(payload).not.toContain("Daily usage overview");
        expectSafePayload(payload);
        if (response.status() === 307) expect(response.headers().location).toBe("/no-access");
        else {
          expect(response.status()).toBe(200);
          expect(response.headers()["content-type"]).toContain("text/x-component");
          if (name !== "prefetch") expect(payload).toContain("NEXT_REDIRECT;replace;/no-access;307;");
        }
      }
      for (const path of ["/api/usage/overview", "/api/usage/breakdown", "/api/users"]) {
        const response = await page.request.get(path);
        expect(response.status()).toBe(403);
        expect(response.headers()["cache-control"]).toBe("private, no-store");
      }
      console.log("grant revocation: updated=1, authenticated HTML/Flight denied, APIs=403");
    } finally {
      try {
        if (grantId) {
          const restored = await pool.request().input("grant", sql.BigInt, grantId)
            .input("principal", sql.UniqueIdentifier, AUTH_PRINCIPALS_BY_PERSONA.manager)
            .query("UPDATE portal.AccessGrant SET revoked_at = NULL WHERE grant_id = @grant AND principal_id = @principal AND revoked_at IS NOT NULL");
          expect(restored.rowsAffected).toEqual([1]);
          const verified = await pool.request().input("grant", sql.BigInt, grantId)
            .query<{ active: number }>("SELECT COUNT(*) AS active FROM portal.v_active_grant WHERE grant_id = @grant");
          expect(verified.recordset).toEqual([{ active: 1 }]);
          expect((await page.request.get("/")).status()).toBe(200);
          console.log("grant revocation: restored=1, active view and authenticated page verified");
        }
      } finally { await pool.close(); }
    }
  });
});
