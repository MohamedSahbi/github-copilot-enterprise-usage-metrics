// Settings for the local stack (docker/compose.local.yml). Throwaway credentials, loopback only.
import { createHash } from "node:crypto";

export const LOCAL_DATABASE = "portal_local";
const DEFAULT_PASSWORD = "Local-Dev-Only-1!";
const DEFAULT_PORT = "14330";

export function localConnectionString(env: Record<string, string | undefined>, database = LOCAL_DATABASE): string {
  const port = env.LOCAL_SQL_PORT ?? DEFAULT_PORT;
  const password = env.LOCAL_SQL_SA_PASSWORD ?? DEFAULT_PASSWORD;
  if (!/^\d{1,5}$/.test(port)) throw new Error("LOCAL_SQL_PORT must be a number");
  if (/[;=]/.test(password)) throw new Error("LOCAL_SQL_SA_PASSWORD must not contain ';' or '='");
  return `Server=127.0.0.1,${port};Database=${database};User Id=sa;Password=${password};Encrypt=true;TrustServerCertificate=true`;
}

export function assertExplicitLocalConnection(env: Record<string, string | undefined>): void {
  if (!env.LOCAL_SQL_PORT || !env.SQL_CONNECTION_STRING) {
    throw new Error("Explicit LOCAL_SQL_PORT and SQL_CONNECTION_STRING are required; no fallback.");
  }
  const expected = localConnectionString(env);
  assertLocalHost(expected);
  if (env.SQL_CONNECTION_STRING !== expected) {
    throw new Error("SQL_CONNECTION_STRING must match the explicit local stack target.");
  }
}

// Fixture loading writes staging tables, which only ingestion may do against a real database (D-34).
export function assertLocalHost(connectionString: string): void {
  const parts = connectionString
    .split(";")
    .map((part) => part.trim());
  const hosts = parts
    .map((part) => /^\s*(server|data source|address|addr|network address)\s*=\s*(.*)$/i.exec(part))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => (m[2] ?? "").trim().replace(/^tcp:/i, "").split(",")[0]!.trim().toLowerCase());
  // Exactly one host key, so a later duplicate cannot override the checked one.
  if (hosts.length !== 1 || (hosts[0] !== "127.0.0.1" && hosts[0] !== "localhost")) {
    throw new Error("Refusing to run: the target is not a local SQL Server (127.0.0.1 or localhost).");
  }
  const databases = parts
    .map((part) => /^\s*(database|initial catalog)\s*=\s*(.*)$/i.exec(part))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => (m[2] ?? "").trim().toLowerCase());
  if (databases.length !== 1 || databases[0] !== LOCAL_DATABASE.toLowerCase()) {
    throw new Error(`Refusing to run: the target database must be ${LOCAL_DATABASE}.`);
  }
}

export interface FixtureRun {
  runId: string;
  file: string;
  blobPath: string;
}

export const FIXTURE_SCOPE_KEY = "example-enterprise";
export const FIXTURE_BLOB_CONTAINER = "raw";

export function planFixtureRuns(): FixtureRun[] {
  return [
    { runId: "00000000-0000-4000-8000-0000000000f1", file: "users-1-day.ndjson", blobPath: "fixtures/users-1-day.ndjson" },
    { runId: "00000000-0000-4000-8000-0000000000f2", file: "users-1-day.invalid.ndjson", blobPath: "fixtures/users-1-day.invalid.ndjson" },
  ];
}

export const sha256Hex = (data: string): string => createHash("sha256").update(data).digest("hex");
