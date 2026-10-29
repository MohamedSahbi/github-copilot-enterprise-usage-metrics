// Creates the runtime identities' contained database users and maps each to its roles (docs/runbooks/database-grants.md).
// Idempotent: an existing user is kept and an existing membership is not re-added. Each ingestion identity passes the
// effective-permission preflight before and after its role is added; a THROW stops that identity, never removes access.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type RuntimeComponent = "portal" | "ingestion" | "directory";

export interface RuntimeIdentity {
  name: string;
  principal_id: string;
}

export type RuntimeIdentities = Record<RuntimeComponent, RuntimeIdentity>;

export const RUNTIME_ROLES: Record<RuntimeComponent, readonly string[]> = {
  portal: ["portal_reader", "portal_writer"],
  ingestion: ["portal_metrics_ingest"],
  directory: ["portal_directory_ingest"],
};

/** Ingestion roles get the effective-permission preflight; the portal roles have none. */
const PREFLIGHT_COMPONENTS = new Set<RuntimeComponent>(["ingestion", "directory"]);

export const PREFLIGHT_SQL = readFileSync(join(__dirname, "sql", "ingestion-preflight.sql"), "utf8");

export interface SqlExecutor {
  /** Runs one batch and returns its first recordset. */
  batch(text: string): Promise<Array<Record<string, unknown>>>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRuntimeIdentities(json: string): RuntimeIdentities {
  const value = JSON.parse(json) as Record<string, Partial<RuntimeIdentity> | undefined>;
  const result = {} as RuntimeIdentities;
  for (const component of Object.keys(RUNTIME_ROLES) as RuntimeComponent[]) {
    const identity = value[component];
    if (!identity?.name || !NAME.test(identity.name) || !identity.principal_id || !GUID.test(identity.principal_id)) {
      throw new Error(`Runtime identity "${component}" needs a name and a principal (object) ID GUID`);
    }
    result[component] = { name: identity.name, principal_id: identity.principal_id };
  }
  return result;
}

export function preflightSql(name: string, role: string, requireMembership: boolean): string {
  return PREFLIGHT_SQL.replace("{{identity_name}}", name)
    .replace("{{component_role}}", role)
    .replace("{{require_component_membership}}", requireMembership ? "1" : "0");
}

// Names and IDs are validated above, so they are safe as N'' literals and bracketed identifiers.
function createUserSql({ name, principal_id }: RuntimeIdentity): string {
  return `IF DATABASE_PRINCIPAL_ID(N'${name}') IS NULL
BEGIN
    DECLARE @sid varbinary(16) = CONVERT(varbinary(16), CAST('${principal_id}' AS uniqueidentifier));
    DECLARE @sql nvarchar(max) = N'CREATE USER ' + QUOTENAME(N'${name}') + N' WITH SID = ' + CONVERT(nvarchar(34), @sid, 1) + N', TYPE = E';
    EXEC (@sql);
END;`;
}

async function isMember(db: SqlExecutor, role: string, name: string): Promise<boolean> {
  const rows = await db.batch(`SELECT IS_ROLEMEMBER(N'${role}', N'${name}') AS member;`);
  return rows[0]?.member === 1;
}

export async function ensureRuntimeUser(
  db: SqlExecutor, component: RuntimeComponent, identity: RuntimeIdentity, log: (message: string) => void,
): Promise<void> {
  await db.batch(createUserSql(identity));
  const preflight = PREFLIGHT_COMPONENTS.has(component);
  for (const role of RUNTIME_ROLES[component]) {
    if (await isMember(db, role, identity.name)) {
      log(`${identity.name}: already in ${role}`);
    } else {
      if (preflight) await db.batch(preflightSql(identity.name, role, false));
      await db.batch(`ALTER ROLE ${role} ADD MEMBER [${identity.name}];`);
      log(`${identity.name}: added to ${role}`);
    }
    if (preflight) await db.batch(preflightSql(identity.name, role, true));
  }
}

/** Maps every identity; one identity's failure does not stop the others. Returns the components that failed. */
export async function ensureRuntimeUsers(
  db: SqlExecutor, identities: RuntimeIdentities, log: (message: string) => void,
): Promise<RuntimeComponent[]> {
  const failed: RuntimeComponent[] = [];
  for (const component of Object.keys(RUNTIME_ROLES) as RuntimeComponent[]) {
    try {
      await ensureRuntimeUser(db, component, identities[component], log);
    } catch (error) {
      failed.push(component);
      log(`${identities[component].name}: stopped: ${(error as Error).message}`);
    }
  }
  return failed;
}
