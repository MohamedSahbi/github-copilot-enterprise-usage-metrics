// Local stack: `npm run stack:up` / `npm run stack:down` / `npm run db:fixtures`.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import sql from "mssql";
import { migrate } from "../db/migrate";
import { LOCAL_DATABASE, assertLocalHost, localConnectionString } from "./config";
import { loadFixtures } from "./load-fixtures";
import { loadLocalCuratedData } from "./local-curated-data";

const compose = join(__dirname, "..", "..", "docker", "compose.local.yml");

function docker(...args: string[]): void {
  const result = spawnSync("docker", ["compose", "-f", compose, ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`docker compose ${args[0]} failed (exit ${result.status ?? "signal"})`);
}

async function ensureDatabase(): Promise<void> {
  const pool = await new sql.ConnectionPool(localConnectionString(process.env, "master")).connect();
  try {
    await pool.request().batch(`IF DB_ID(N'${LOCAL_DATABASE}') IS NULL CREATE DATABASE [${LOCAL_DATABASE}]`);
  } finally {
    await pool.close();
  }
}

async function up(): Promise<void> {
  const cs = localConnectionString(process.env);
  assertLocalHost(cs);
  docker("up", "-d", "--wait", "--wait-timeout", "300");
  await ensureDatabase();
  const { applied } = await migrate({ connectionString: cs, log: (m) => console.log(m) });
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
  const { runs } = await loadFixtures(cs);
  for (const r of runs) console.log(`Fixtures ${r.file}: ${r.lines} lines, ${r.loaded} staged, ${r.issues} issues`);
  const curated = await loadLocalCuratedData(cs);
  console.log(`Test-only curated seed: ${curated.users} users, ${curated.organizations} organizations, ${curated.usageFacts} usage facts, ${curated.aiCreditFacts} AI Credits facts`);
  console.log(`Stack ready. Connection: ${cs.replace(/Password=[^;]*/, "Password=***")}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "up") await up();
  else if (command === "down") docker("down", "-v", "--remove-orphans");
  else if (command === "fixtures") {
    const cs = localConnectionString(process.env);
    const { runs } = await loadFixtures(cs);
    for (const r of runs) console.log(`Fixtures ${r.file}: ${r.lines} lines, ${r.loaded} staged, ${r.issues} issues`);
    const curated = await loadLocalCuratedData(cs);
    console.log(`Test-only curated seed: ${curated.users} users, ${curated.organizations} organizations, ${curated.usageFacts} usage facts, ${curated.aiCreditFacts} AI Credits facts`);
  } else {
    console.error("usage: stack.ts up|down|fixtures");
    process.exit(2);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
