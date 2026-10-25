import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertLocalHost, localConnectionString, planFixtureRuns } from "./config";

const compose = readFileSync(join(__dirname, "..", "..", "docker", "compose.local.yml"), "utf8");

describe("docker/compose.local.yml", () => {
  it("pins SQL Server 2022 and Azurite by version and runs SQL Server as amd64", () => {
    expect(compose).toMatch(/image:\s*mcr\.microsoft\.com\/mssql\/server:2022-/);
    expect(compose).toMatch(/image:\s*mcr\.microsoft\.com\/azure-storage\/azurite:\d+\.\d+\.\d+/);
    expect(compose).toMatch(/mssql\/server:2022-[\w.-]+@sha256:[0-9a-f]{64}/);
    expect(compose).toMatch(/azurite:\d+\.\d+\.\d+/);
    expect(compose).toMatch(/platform:\s*linux\/amd64/);
  });

  it("binds every published port to loopback only", () => {
    const ports = [...compose.matchAll(/^\s*-\s*"([^"]+:\d+)"/gm)].map((m) => m[1]!);
    expect(ports.length).toBeGreaterThanOrEqual(4);
    for (const p of ports) expect(p, p).toMatch(/^127\.0\.0\.1:/);
  });

  it("has a SQL Server healthcheck with a long start period for emulation", () => {
    expect(compose).toMatch(/healthcheck:/);
    expect(compose).toMatch(/start_period:\s*\d+s/);
  });

  it("does not contain real credentials", () => {
    expect(compose).not.toMatch(/AccountKey=/i);
  });
});

describe("local stack config", () => {
  it("builds a loopback connection string for the portal database", () => {
    const cs = localConnectionString({});
    expect(cs).toContain("Server=127.0.0.1,14330");
    expect(cs).toContain("Database=portal_local");
  });

  it("refuses non-loopback hosts", () => {
    expect(() => assertLocalHost("Server=127.0.0.1,14330;Database=x")).not.toThrow();
    expect(() => assertLocalHost("Server=localhost,1433;Database=x")).not.toThrow();
    expect(() => assertLocalHost("Server=tcp:prod.database.windows.net,1433;Database=x")).toThrow(/local/i);
    expect(() => assertLocalHost("Server=10.0.0.4;Database=x")).toThrow(/local/i);
    expect(() => assertLocalHost("Database=x")).toThrow(/local/i);
    expect(() => assertLocalHost("Server=localhost;Server=prod.example.net")).toThrow(/local/i);
    expect(() => assertLocalHost("Server=localhost;Address=prod.example.net")).toThrow(/local/i);
    expect(() => assertLocalHost("Addr=prod.example.net;Database=x")).toThrow(/local/i);
    expect(() => localConnectionString({ LOCAL_SQL_PORT: "1;Server=x" })).toThrow(/port/i);
    expect(() => localConnectionString({ LOCAL_SQL_SA_PASSWORD: "a;b" })).toThrow(/password/i);
  });

  it("plans one valid run and one invalid run with fixed ids", () => {
    const runs = planFixtureRuns();
    expect(runs.map((r) => r.file)).toEqual(["users-1-day.ndjson", "users-1-day.invalid.ndjson"]);
    expect(new Set(runs.map((r) => r.runId)).size).toBe(2);
  });
});
