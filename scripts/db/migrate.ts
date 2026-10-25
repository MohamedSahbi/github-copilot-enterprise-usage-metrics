// Forward-only migration runner for the portal schema (D-34, D-48).
// postgrator decides nothing about ordering or checksums here: plan.ts validates the history first, then postgrator applies
// the pending files. Everything runs on ONE connection that holds an sp_getapplock session lock, so two pipeline runs never overlap.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import sql from "mssql";
import Postgrator from "postgrator";
import { MigrationError, parseMigrationName, planMigrations, type AppliedMigration, type MigrationFile } from "./plan";
import { splitBatches } from "./split-go";

export const LOCK_RESOURCE = "portal-migrations";
export const DEFAULT_MIGRATIONS_DIR = join(__dirname, "..", "..", "db", "migrations");

export interface MigrateOptions {
  connectionString: string;
  dir?: string;
  lockTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  outOfOrder: number[];
}

// Same shape as db/migrations/20261026000100: the table must exist before the history can be read, and it must live in
// portal, not in dbo where postgrator would create its default table.
const BOOTSTRAP = `
IF SCHEMA_ID(N'portal') IS NULL EXEC(N'CREATE SCHEMA portal');
IF OBJECT_ID(N'portal.schema_version', N'U') IS NULL
CREATE TABLE portal.schema_version (
    version BIGINT       NOT NULL CONSTRAINT PK_schema_version PRIMARY KEY,
    name    VARCHAR(128) NULL,
    md5     VARCHAR(32)  NULL,
    run_at  DATETIME2(0) NULL
);`;

async function acquireLock(pool: sql.ConnectionPool, timeoutMs: number): Promise<void> {
  const result = await pool
    .request()
    .input("Resource", sql.NVarChar(255), LOCK_RESOURCE)
    .input("LockMode", sql.VarChar(32), "Exclusive")
    .input("LockOwner", sql.VarChar(32), "Session")
    .input("LockTimeout", sql.Int, timeoutMs)
    .execute("sp_getapplock");
  if (Number(result.returnValue) < 0) {
    throw new MigrationError("LOCK_TIMEOUT", `Could not acquire the "${LOCK_RESOURCE}" lock within ${timeoutMs} ms; another migration run is active`);
  }
}

export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const dir = options.dir ?? DEFAULT_MIGRATIONS_DIR;
  const log = options.log ?? (() => undefined);

  const names = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  for (const f of names) parseMigrationName(f);

  const config: sql.config = {
    ...sql.ConnectionPool.parseConnectionString(options.connectionString),
    pool: { min: 1, max: 1 },
    requestTimeout: 600_000,
  };
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  let locked = false;
  try {
    await acquireLock(pool, options.lockTimeoutMs ?? 60_000);
    locked = true;
    log(`acquired lock ${LOCK_RESOURCE}`);

    const batch = async (text: string) => (await pool.request().batch(text)).recordset ?? [];
    await batch(BOOTSTRAP);

    const postgrator = new Postgrator({
      driver: "mssql",
      database: config.database ?? "",
      schemaTable: "portal.schema_version",
      migrationPattern: join(dir, "*.sql"),
      newline: "LF",
      validateChecksums: false,
      execQuery: async (query) => ({ rows: await batch(query) }),
      execSqlScript: async (script) => {
        for (const text of splitBatches(script)) await batch(text);
      },
    });

    const found = await postgrator.getMigrations();
    const files: MigrationFile[] = found.map((m) => ({ version: m.version, name: m.name, md5: m.md5, filename: m.filename }));
    const rows = (await batch("SELECT version, name, md5 FROM portal.schema_version")) as Array<{ version: string | number; name: string | null; md5: string | null }>;
    const applied: AppliedMigration[] = rows.map((r) => ({ version: Number(r.version), name: r.name, md5: r.md5 }));

    const plan = planMigrations(files, applied);
    if (plan.outOfOrder.length > 0) log(`warning: applying migrations older than the newest applied one: ${plan.outOfOrder.join(", ")}`);
    const pending = new Set(plan.pending.map((m) => m.version));
    const toRun = found.filter((m) => pending.has(m.version)).sort((a, b) => a.version - b.version);

    postgrator.on("migration-started", (m) => log(`applying ${m.version} ${m.name}`));
    try {
      await postgrator.runMigrations(toRun);
    } catch (error) {
      throw new Error(`Migration failed: ${(error as Error).message}. Earlier migrations stay applied; fix and re-run.`, { cause: error });
    }
    log(`applied ${toRun.length} migration(s); ${applied.length} already applied`);
    return { applied: toRun.map((m) => `${m.version}.${m.name}`), outOfOrder: plan.outOfOrder };
  } finally {
    try {
      if (locked) {
        await pool
          .request()
          .input("Resource", sql.NVarChar(255), LOCK_RESOURCE)
          .input("LockOwner", sql.VarChar(32), "Session")
          .execute("sp_releaseapplock");
      }
    } finally {
      await pool.close();
    }
  }
}
