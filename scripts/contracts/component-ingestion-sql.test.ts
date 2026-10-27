import { execFileSync } from "node:child_process";
import sql from "mssql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertComponentIngestionPermissions } from "./component-ingestion-permissions";
import { migrate } from "../db/migrate";

const enabled = process.env.COMPONENT_INGESTION_SQL_TESTS === "1";
const expectedProject = "component-ingestion-sql-d21a4ba4";
const expectedOwnerSession = "d21a4ba4-ee15-4791-9bbf-8034ce6ce632";
const expectedImage = "mcr.microsoft.com/mssql/server:2022-latest@sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718";
const expectedDatabase = "contract_test_d21a4ba4";
const connectionString = process.env.COMPONENT_INGESTION_SQL_CONNECTION_STRING;
const containerId = process.env.COMPONENT_INGESTION_SQL_CONTAINER_ID;
const configHash = process.env.COMPONENT_INGESTION_SQL_CONFIG_HASH;
const launcherPid = process.env.COMPONENT_INGESTION_SQL_LAUNCHER_PID;
const launcherStartUtc = process.env.COMPONENT_INGESTION_SQL_LAUNCHER_START_UTC;
let pool: sql.ConnectionPool | undefined;

interface InspectedContainer {
  Id: string;
  Config: { Image: string; Labels: Record<string, string> };
  State: { Running: boolean };
  HostConfig: { PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }> | null> };
}

function assertAllocatedContainer(): void {
  if (!containerId || !/^[a-f0-9]{64}$/.test(containerId) ||
      !configHash || !/^[a-f0-9]{64}$/.test(configHash) ||
      !launcherPid || !/^[1-9]\d*$/.test(launcherPid) ||
      !launcherStartUtc || Number.isNaN(Date.parse(launcherStartUtc))) {
    throw new Error("Component SQL test requires the complete allocator-owned container identity");
  }

  const inspected = JSON.parse(execFileSync("docker", ["inspect", containerId], { encoding: "utf8" })) as InspectedContainer[];
  const container = inspected[0];
  const labels = container?.Config.Labels;
  const bindings = container?.HostConfig.PortBindings["1433/tcp"];
  const expectedBinding = bindings?.length === 1 &&
    bindings[0]?.HostIp === "127.0.0.1" && bindings[0]?.HostPort === "14505";
  if (inspected.length !== 1 || container?.Id !== containerId || !container.State.Running ||
      container.Config.Image !== expectedImage ||
      labels?.["com.docker.compose.project"] !== expectedProject ||
      labels?.["com.docker.compose.config-hash"] !== configHash ||
      labels?.["copilot.owner-session"] !== expectedOwnerSession ||
      labels?.["copilot.launcher-pid"] !== launcherPid ||
      labels?.["copilot.launcher-start-utc"] !== launcherStartUtc ||
      !expectedBinding) {
    throw new Error("Component SQL test endpoint is not the allocated owner container");
  }
}

function makeConnectionPool(connectionStringValue: string): sql.ConnectionPool {
  const options = new Map<string, string>();
  for (const part of connectionStringValue.split(";")) {
    if (!part.trim()) continue;
    const separator = part.indexOf("=");
    if (separator <= 0) {
      throw new Error("Component SQL test connection string is malformed");
    }
    const key = part.slice(0, separator).trim().toLowerCase().replaceAll(" ", "");
    if (!["server", "database", "userid", "password", "encrypt", "trustservercertificate"].includes(key) ||
        options.has(key)) {
      throw new Error("Component SQL test connection string contains unsupported or duplicate options");
    }
    options.set(key, part.slice(separator + 1).trim());
  }
  if (options.get("server") !== "127.0.0.1,14505" ||
      options.get("database") !== expectedDatabase ||
      !options.get("userid") || !options.get("password")) {
    throw new Error("Component SQL test connection must target the allocated loopback endpoint and synthetic database");
  }

  const candidate = new sql.ConnectionPool(connectionStringValue);
  return candidate;
}

describe.skipIf(!enabled)("allocated component-ingestion SQL permissions", () => {
  beforeAll(async () => {
    if (!connectionString) {
      throw new Error("Component SQL test requires COMPONENT_INGESTION_SQL_CONNECTION_STRING");
    }
    assertAllocatedContainer();
    pool = makeConnectionPool(connectionString);
    await pool.connect();
    const database = await pool.request().query<{
      database_name: string;
      user_table_count: number;
      portal_schema_exists: number;
    }>(`
      SELECT DB_NAME() AS database_name,
        (SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0) AS user_table_count,
        CASE WHEN SCHEMA_ID(N'portal') IS NULL THEN 0 ELSE 1 END AS portal_schema_exists
    `);
    const target = database.recordset[0];
    if (target?.database_name !== expectedDatabase ||
        target.user_table_count !== 0 || target.portal_schema_exists !== 0) {
      throw new Error("Component SQL test requires the allocated, empty synthetic database");
    }
    await migrate({ connectionString });
  });

  afterAll(async () => {
    await pool?.close();
  });

  it("enforces the same effective-role contract as hosted SQL validation", async () => {
    const activePool = pool;
    if (!activePool) throw new Error("Allocated SQL connection was not initialized");
    const execute = async (statement: string): Promise<void> => {
      await activePool.request().batch(statement);
    };
    const expectDenied = async (statement: string): Promise<void> => {
      await expect(execute(statement)).rejects.toThrow(/permission (?:was )?denied|do not have permission|permission denied/i);
    };
    const expectError = async (statement: string, message: RegExp): Promise<void> => {
      await expect(execute(statement)).rejects.toThrow(message);
    };
    await assertComponentIngestionPermissions({ execute, expectDenied, expectError });
  });
});
