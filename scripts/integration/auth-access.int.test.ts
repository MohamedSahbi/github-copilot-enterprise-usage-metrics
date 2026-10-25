import sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openPool } from "./db";
import { AUTH_OBJECTS, AUTH_PRINCIPALS, AUTH_TENANT, seedAuth } from "./auth-seed";
import { SqlAccessRepository } from "../../portal/src/authz/sql-access";
import { resolveAccess, type Identity } from "../../portal/src/authz/access";
import { readAccessSettings } from "../../portal/src/auth/settings";
import { validateGrantRequest } from "../../shared/src/access";

let pool: sql.ConnectionPool;
let repository: SqlAccessRepository;
const entra = (index: number): Identity => ({
  provider: "entra", tenantId: AUTH_TENANT, objectId: AUTH_OBJECTS[index]!, groups: [],
});
describe("SQL-backed immutable principal and active-grant reads", () => {
  beforeAll(async () => {
    pool = await openPool();
    await seedAuth(pool);
    repository = new SqlAccessRepository(pool);
  });
  afterAll(async () => {
    await seedAuth(pool);
    await pool.close();
  });
  it("resolves Entra on tenant + object ID, and GitHub only on an active stored link", async () => {
    expect((await repository.read(entra(0))).principal?.principal_id.toLowerCase()).toBe(AUTH_PRINCIPALS[0]);
    const github = await repository.read({ provider: "github", userId: 990085001 });
    expect(github.principal?.principal_id.toLowerCase()).toBe(AUTH_PRINCIPALS[0]);
    expect((await repository.read({ ...entra(0), tenantId: AUTH_OBJECTS[0]! } as Identity)).principal).toBeNull();
    expect((await repository.read({ provider: "github", userId: 123456789 })).principal).toBeNull();
  });
  it("returns safe numeric user IDs from authorized SQL directory scopes", async () => {
    const adminUsers = await repository.readScopedUsers(AUTH_OBJECTS[0]!, [
      { role: "admin", scope: "company", scope_value: "" },
    ]);
    expect(adminUsers.map(({ user_id }) => user_id).sort((a, b) => a - b)).toEqual([
      1000001, 1000003, 1000004, 1000006, 1000007, 1000008, 1000009, 1000011, 1000012,
    ]);

    const managerUsers = await repository.readScopedUsers(AUTH_OBJECTS[1]!, [
      { role: "manager", scope: "team", scope_value: "" },
    ]);
    expect(managerUsers.map(({ user_id }) => user_id).sort((a, b) => a - b)).toEqual([1000003, 1000007]);
  });
  it("sees revocation on the next read through v_active_grant", async () => {
    const id = AUTH_PRINCIPALS[2]!;
    expect((await repository.read(entra(2))).grants).toHaveLength(1);
    await pool.request().input("id", sql.UniqueIdentifier, id)
      .query("UPDATE portal.AccessGrant SET revoked_at = SYSUTCDATETIME() WHERE principal_id = @id");
    try {
      expect((await repository.read(entra(2))).grants).toHaveLength(0);
    } finally {
      await pool.request().input("id", sql.UniqueIdentifier, id)
        .query("UPDATE portal.AccessGrant SET revoked_at = NULL WHERE principal_id = @id");
    }
  });
  it("resolves validator facts from SQL rather than trusting caller booleans or scope values", async () => {
    const settings = readAccessSettings({ DIRECTORY_DEPARTMENT_ATTRIBUTE: "department" });
    const real = await repository.grantValidationContext(AUTH_TENANT, AUTH_OBJECTS[0]!, settings);
    expect(validateGrantRequest({ principalEntraObjectId: AUTH_OBJECTS[0]!, role: "user", scope: "self" }, real).ok).toBe(true);
    const unknown = "00000000-0000-4000-8000-000000000999";
    const facts = await repository.grantValidationContext(AUTH_TENANT, unknown, settings);
    expect(validateGrantRequest({ principalEntraObjectId: unknown, role: "user", scope: "self" }, facts))
      .toEqual({ ok: false, code: "principal_not_linked" });
    expect(validateGrantRequest({
      principalEntraObjectId: AUTH_OBJECTS[0]!, role: "executive", scope: "department", scopeValue: "caller-invented",
    }, real)).toEqual({ ok: false, code: "unknown_scope_value" });
  });
  it("denies elevated scope when one required sync source is stale, but keeps manager scope", async () => {
    await pool.request().query("UPDATE portal.DirectorySyncState SET last_success_at = DATEADD(hour, -37, SYSUTCDATETIME()) WHERE source = 'graph'");
    try {
      expect((await resolveAccess(entra(0), repository, readAccessSettings({}))).state).toBe("no-access");
      expect((await resolveAccess(entra(1), repository, readAccessSettings({}))).state).toBe("authorized");
    } finally {
      await seedAuth(pool);
    }
  });
  it("keeps Entra sign-in keyed on the object ID when a GitHub link is unlinked", async () => {
    await pool.request().query(`
      UPDATE portal.PrincipalLinkState SET unlinked_at = SYSUTCDATETIME(),
        unlink_reason = 'github_removed', unlink_seq = NEXT VALUE FOR portal.seq_access_event
      WHERE entra_tenant_id = '${AUTH_TENANT}' AND entra_object_id = '${AUTH_OBJECTS[3]}' AND unlinked_at IS NULL`);
    expect((await repository.read(entra(3))).principal).not.toBeNull();
    expect((await repository.read({ provider: "github", userId: 990085004 })).principal).toBeNull();
  });
});
