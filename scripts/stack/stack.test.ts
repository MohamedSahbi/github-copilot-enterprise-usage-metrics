import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertLocalHost, localConnectionString, planFixtureRuns } from "./config";
import {
  TEST_CURATED_EXPECTED_COUNTS,
  TEST_CURATED_PERSONAS,
  TEST_CURATED_SCOPE_ASSIGNMENTS,
} from "./test-only-curated-seed";

const syntheticUsage = readFileSync(join(__dirname, "..", "..", "fixtures", "synthetic", "users-1-day.ndjson"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { organization_id: number; user_id: number });
const syntheticAiCredits = readFileSync(join(__dirname, "..", "..", "fixtures", "synthetic", "ai-credit.csv"), "utf8")
  .split("\n")
  .filter(Boolean)
  .length - 1;

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
    expect(() => assertLocalHost("Server=127.0.0.1,14330;Database=portal_local")).not.toThrow();
    expect(() => assertLocalHost("Server=localhost,1433;Database=portal_local")).not.toThrow();
    expect(() => assertLocalHost("Server=tcp:prod.database.windows.net,1433;Database=x")).toThrow(/local/i);
    expect(() => assertLocalHost("Server=10.0.0.4;Database=x")).toThrow(/local/i);
    expect(() => assertLocalHost("Database=portal_local")).toThrow(/local/i);
    expect(() => assertLocalHost("Server=localhost;Database=master")).toThrow(/database/i);
    expect(() => assertLocalHost("Server=localhost;Database=portal_local;Initial Catalog=master")).toThrow(/database/i);
    expect(() => assertLocalHost("Server=localhost;Server=prod.example.net;Database=portal_local")).toThrow(/local/i);
    expect(() => assertLocalHost("Server=localhost;Address=prod.example.net;Database=portal_local")).toThrow(/local/i);
    expect(() => assertLocalHost("Addr=prod.example.net;Database=x")).toThrow(/local/i);
    expect(() => localConnectionString({ LOCAL_SQL_PORT: "1;Server=x" })).toThrow(/port/i);
    expect(() => localConnectionString({ LOCAL_SQL_SA_PASSWORD: "a;b" })).toThrow(/password/i);
  });

  it("plans one valid run and one invalid run with fixed ids", () => {
    const runs = planFixtureRuns();
    expect(runs.map((r) => r.file)).toEqual(["users-1-day.ndjson", "users-1-day.invalid.ndjson"]);
    expect(new Set(runs.map((r) => r.runId)).size).toBe(2);
  });

  it("covers synthetic organization counts, persona scopes, hierarchy, and a suppressed group", () => {
    const userIds = [...new Set(syntheticUsage.map((row) => row.user_id))].sort();
    const organizationIds = [...new Set(syntheticUsage.map((row) => row.organization_id))].sort();
    const assignments = TEST_CURATED_SCOPE_ASSIGNMENTS;

    expect(syntheticUsage).toHaveLength(TEST_CURATED_EXPECTED_COUNTS.usageFacts);
    expect(userIds).toHaveLength(TEST_CURATED_EXPECTED_COUNTS.users);
    expect(organizationIds).toHaveLength(TEST_CURATED_EXPECTED_COUNTS.organizations);
    expect(syntheticAiCredits).toBe(TEST_CURATED_EXPECTED_COUNTS.aiCreditFacts);
    expect(Object.keys(assignments).map(Number).sort()).toEqual(userIds);
    expect(TEST_CURATED_PERSONAS).toMatchObject({
      admin: { role: "admin", scope: "company" },
      manager: { role: "manager", scope: "team", userId: 1000001 },
      member: { role: "user", scope: "self", userId: 1000006 },
      "no-access": { scope: "none", userId: 1000012 },
    });

    const directReports = Object.entries(assignments)
      .filter(([, assignment]) => assignment.managerUserId === 1000001)
      .map(([userId]) => Number(userId));
    const indirectReports = Object.entries(assignments)
      .filter(([, assignment]) => assignment.managerUserId !== null)
      .filter(([, assignment]) => assignments[assignment.managerUserId!]?.managerUserId === 1000001)
      .map(([userId]) => Number(userId));
    expect(directReports).toEqual([1000003]);
    expect(indirectReports).toEqual([1000007]);

    const smallGroup = Object.entries(assignments)
      .filter(([, assignment]) => assignment.department === "department-small")
      .map(([userId]) => Number(userId));
    expect(smallGroup).toEqual([1000004, 1000008]);
    expect(new Set(smallGroup.map((id) => syntheticUsage.find((row) => row.user_id === id)?.organization_id)).size).toBe(1);
    expect(smallGroup.length).toBe(TEST_CURATED_EXPECTED_COUNTS.smallGroupUsers);
    expect(smallGroup.length).toBeLessThan(TEST_CURATED_EXPECTED_COUNTS.minimumGroupSize);
    expect(new Set(Object.values(assignments).map((assignment) => assignment.department)).size).toBeGreaterThan(1);
    expect(new Set(Object.values(assignments).map((assignment) => assignment.businessArea)).size).toBeGreaterThan(1);
  });
});
