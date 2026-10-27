import sql from "mssql";
import { describe, expect, it, vi } from "vitest";
import { SqlAccessRepository } from "./sql-access";
import { getUsageBreakdown, getUsageOverview, getUserUsage } from "../usage/sql-usage";
import type { AuthorizedUsageAccess } from "../usage/api";

const objectId = "00000000-0000-4000-8000-000000000001";
const access: AuthorizedUsageAccess = {
  state: "authorized", breakGlass: false, namesVisible: true,
  principal: { principal_id: objectId, entra_tenant_id: objectId, entra_object_id: objectId, github_user_id: null, status: "active" },
  grants: [{ role: "manager", scope: "team", scope_value: "" }],
};

function fakePool() {
  const queries: string[] = [];
  const requests: sql.Request[] = [];
  const pool = new sql.ConnectionPool({ server: "unused" });
  vi.spyOn(pool, "request").mockImplementation(() => {
    const request = new sql.Request(pool);
    requests.push(request);
    vi.spyOn(request, "query").mockImplementation(async (text) => {
      queries.push(String(text));
      return { recordset: [], recordsets: [], rowsAffected: [], output: {} };
    });
    return request;
  });
  return { pool, queries, requests };
}

describe("per-report manager freshness in SQL scopes", () => {
  it.each(["scoped-users", "overview", "breakdown", "users"] as const)(
    "gates each traversed edge, not the entire source, for %s", async (reader) => {
      const { pool, queries, requests } = fakePool();
      const range = { from: "2026-03-01", to: "2026-03-02", page: 1, pageSize: 50 };
      if (reader === "scoped-users") await new SqlAccessRepository(pool).readScopedUsers(objectId, access.grants);
      if (reader === "overview") await getUsageOverview(pool, access, range, objectId);
      if (reader === "breakdown") await getUsageBreakdown(pool, access, { ...range, kind: "feature" }, objectId);
      if (reader === "users") await getUserUsage(pool, access, range, objectId);
      expect(queries.length).toBeGreaterThan(0);
      const alias = reader === "scoped-users" ? "child" : "u";
      for (const text of queries) {
        expect(text).toContain(`${alias}.manager_resolved = 1`);
        expect(text).toContain(`${alias}.manager_checked_at >= DATEADD(hour, -@teamDirectoryStaleHours, SYSUTCDATETIME())`);
        expect(text).toContain(`${alias}.manager_checked_at <= DATEADD(millisecond, 500, SYSUTCDATETIME())`);
        expect(text).not.toContain("DirectorySyncState");
      }
      for (const request of requests) expect(request.parameters.teamDirectoryStaleHours?.value).toBe(36);
    },
  );
});
