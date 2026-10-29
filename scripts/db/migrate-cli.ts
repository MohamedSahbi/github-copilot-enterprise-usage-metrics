// CLI for the migration runner: SQL_CONNECTION_STRING=... npm run db:migrate, or the Entra token variables in connection.ts.
// Connection settings are read from the environment only and are never printed.
import type sql from "mssql";
import { connectionFromEnvironment } from "./connection";
import { migrate } from "./migrate";

let connectionString: sql.config;
try {
  connectionString = connectionFromEnvironment(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

const lockTimeoutMs = process.env.MIGRATION_LOCK_TIMEOUT_MS ? Number(process.env.MIGRATION_LOCK_TIMEOUT_MS) : undefined;
if (lockTimeoutMs !== undefined && !(Number.isInteger(lockTimeoutMs) && lockTimeoutMs >= 0)) {
  console.error("MIGRATION_LOCK_TIMEOUT_MS must be a non-negative integer");
  process.exit(2);
}

migrate({ connectionString, ...(lockTimeoutMs !== undefined ? { lockTimeoutMs } : {}), log: (m) => console.log(m) }).then(
  (result) => {
    console.log(result.applied.length ? `Applied: ${result.applied.join(", ")}` : "Database is up to date");
  },
  (error: unknown) => {
    console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
