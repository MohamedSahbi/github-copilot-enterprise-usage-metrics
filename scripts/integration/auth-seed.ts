import type sql from "mssql";
import { TEST_PERSONAS, testPersonaObjectId, type TestPersonaId } from "../../portal/src/auth/test-auth";

export const AUTH_TENANT = "00000000-0000-4000-8000-000000000085";
const TEST_PERSONA_IDS = Object.keys(TEST_PERSONAS) as TestPersonaId[];
export const AUTH_PRINCIPALS_BY_PERSONA: Record<TestPersonaId, string> = {
  admin: "00000000-0000-4000-8085-000000000001",
  manager: "00000000-0000-4000-8085-000000000002",
  member: "00000000-0000-4000-8085-000000000003",
  "no-access": "00000000-0000-4000-8085-000000000004",
};
export const AUTH_OBJECTS_BY_PERSONA = Object.fromEntries(
  TEST_PERSONA_IDS.map((persona) => [persona, testPersonaObjectId(persona)]),
) as Record<TestPersonaId, string>;
export const AUTH_PRINCIPALS = TEST_PERSONA_IDS.map((persona) => AUTH_PRINCIPALS_BY_PERSONA[persona]);
export const AUTH_OBJECTS = TEST_PERSONA_IDS.map((persona) => AUTH_OBJECTS_BY_PERSONA[persona]);

// Local synthetic access fixtures only; never called by deployment code.
export async function seedAuth(executor: sql.ConnectionPool | sql.Transaction): Promise<void> {
  for (let index = 0; index < AUTH_PRINCIPALS.length; index++) {
    const principal = AUTH_PRINCIPALS[index]!;
    const oid = AUTH_OBJECTS[index]!;
    await executor.request().query(`
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
      await executor.request().query(`
        IF NOT EXISTS (SELECT 1 FROM portal.v_active_grant WHERE principal_id = '${principal}')
          INSERT INTO portal.AccessGrant (principal_id, principal_entra_oid, role, scope)
          VALUES ('${principal}', '${oid}', '${role}', '${scope}');
      `);
    }
  }
  for (const source of ["scim", "graph", "seats"]) {
    await executor.request().query(`
      UPDATE portal.DirectorySyncState SET last_success_at = DATEADD(second, -1, SYSUTCDATETIME()) WHERE source = '${source}';
      IF @@ROWCOUNT = 0 INSERT INTO portal.DirectorySyncState (source, last_success_at) VALUES ('${source}', DATEADD(second, -1, SYSUTCDATETIME()));
    `);
  }
}
