// CLI: RUNTIME_IDENTITIES='<terraform output -json identities>' npm run db:runtime-users, with the connection variables
// in connection.ts. Run after npm run db:migrate as a member of the SQL admin group. Nothing secret is printed.
import sql from "mssql";
import { connectionFromEnvironment } from "./connection";
import { ensureRuntimeUsers, parseRuntimeIdentities, type RuntimeIdentities } from "./runtime-users";

let config: sql.config;
let identities: RuntimeIdentities;
try {
  config = connectionFromEnvironment(process.env);
  identities = parseRuntimeIdentities(process.env.RUNTIME_IDENTITIES ?? "");
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

async function main(): Promise<number> {
  const pool = new sql.ConnectionPool({ ...config, pool: { min: 1, max: 1 } });
  await pool.connect();
  try {
    const failed = await ensureRuntimeUsers(
      { batch: async (text) => (await pool.request().batch(text)).recordset ?? [] },
      identities,
      (m) => console.log(m),
    );
    if (failed.length) console.error(`Runtime users not ready: ${failed.join(", ")}`);
    return failed.length ? 1 : 0;
  } finally {
    await pool.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`Runtime users failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
