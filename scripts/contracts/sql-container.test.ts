// Optional: applies the migrations to a SQL Server 2022 container. Run with RUN_SQL_TESTS=1 (needs a running Docker daemon).
// Slow under emulation on Apple Silicon (linux/amd64). Never points at a real server.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.RUN_SQL_TESTS === "1";
const migrations = join(__dirname, "..", "..", "db", "migrations");
const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
const name = `portal-sql-test-${randomBytes(4).toString("hex")}`;
const sa = `Aa1!${randomBytes(12).toString("hex")}`;
const SQLCMD = "/opt/mssql-tools18/bin/sqlcmd";

const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8" });
const sqlcmd = (...args: string[]): string =>
  docker("exec", "-e", `SQLCMDPASSWORD=${sa}`, name, SQLCMD, "-C", "-I", "-b", "-S", "localhost", "-U", "sa", ...args);

describe.skipIf(!enabled)("migrations on SQL Server 2022 (RUN_SQL_TESTS=1)", () => {
  beforeAll(async () => {
    expect(spawnSync("docker", ["info"]).status, "docker daemon must be running").toBe(0);
    docker("run", "-d", "--rm", "--platform", "linux/amd64", "--name", name, "-e", "ACCEPT_EULA=Y", "-e", `MSSQL_SA_PASSWORD=${sa}`, "mcr.microsoft.com/mssql/server:2022-latest");
    for (let i = 0; i < 90; i++) {
      try { sqlcmd("-Q", "SELECT 1"); break; } catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
    sqlcmd("-Q", "SELECT 1");
    docker("cp", migrations, `${name}:/migrations`);
  }, 240_000);

  afterAll(() => { spawnSync("docker", ["rm", "-f", name]); });

  const apply = (): void => { for (const f of files) sqlcmd("-d", "portal_test", "-i", `/migrations/${f}`); };

  it("applies in order", () => {
    sqlcmd("-Q", "CREATE DATABASE portal_test");
    expect(() => apply()).not.toThrow();
  }, 240_000);

  it("is idempotent when re-applied (the schema_version bookkeeping aside)", () => {
    expect(() => apply()).not.toThrow();
  }, 240_000);

  it("created only portal objects and nothing in dbo", () => {
    const out = sqlcmd("-d", "portal_test", "-h", "-1", "-W", "-Q", "SET NOCOUNT ON; SELECT COUNT(*) FROM sys.tables WHERE schema_id = SCHEMA_ID('dbo')");
    expect(out.trim()).toBe("0");
  });
});
