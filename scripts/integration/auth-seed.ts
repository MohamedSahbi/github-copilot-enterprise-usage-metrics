import type sql from "mssql";

export const AUTH_TENANT = "00000000-0000-4000-8000-000000000085";
export const AUTH_PRINCIPALS = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8085-00000000000${n}`);
export const AUTH_OBJECTS = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-00000000000${n}`);

// Local synthetic access fixtures only; never called by deployment code.
export async function seedAuth(pool: sql.ConnectionPool): Promise<void> {
  for (let index = 0; index < AUTH_PRINCIPALS.length; index++) {
    const principal = AUTH_PRINCIPALS[index]!;
    const oid = AUTH_OBJECTS[index]!;
    await pool.request().query(`
      IF NOT EXISTS (SELECT 1 FROM portal.Principal WHERE principal_id = '${principal}')
        INSERT INTO portal.Principal (principal_id, entra_tenant_id, entra_object_id, github_user_id)
        VALUES ('${principal}', '${AUTH_TENANT}', '${oid}', ${990085001 + index});
      IF NOT EXISTS (SELECT 1 FROM portal.PrincipalLinkState WHERE entra_tenant_id = '${AUTH_TENANT}' AND entra_object_id = '${oid}' AND unlinked_at IS NULL)
        INSERT INTO portal.PrincipalLinkState (entra_tenant_id, entra_object_id, github_user_id)
        VALUES ('${AUTH_TENANT}', '${oid}', ${990085001 + index});
    `);
    if (index < 3) {
      const role = ["admin", "manager", "user"][index];
      const scope = ["company", "team", "self"][index];
      await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM portal.v_active_grant WHERE principal_id = '${principal}')
          INSERT INTO portal.AccessGrant (principal_id, principal_entra_oid, role, scope)
          VALUES ('${principal}', '${oid}', '${role}', '${scope}');
      `);
    }
  }
  for (const source of ["scim", "graph", "seats"]) {
    await pool.request().query(`
      UPDATE portal.DirectorySyncState SET last_success_at = SYSUTCDATETIME() WHERE source = '${source}';
      IF @@ROWCOUNT = 0 INSERT INTO portal.DirectorySyncState (source, last_success_at) VALUES ('${source}', SYSUTCDATETIME());
    `);
  }
}
