import { describe, expect, it, vi } from "vitest";
import { createMetricsRunStore } from "./run-store.js";

const query = vi.fn();
const input = vi.fn();
const close = vi.fn(async () => undefined);
const request = () => ({ input, query });
input.mockImplementation(() => ({ input, query }));

vi.mock("mssql", () => ({
  default: {
    ConnectionPool: class {
      connect = vi.fn(async () => ({ request, close }));
    },
    BigInt: "bigint", Date: "date", UniqueIdentifier: "uuid",
    VarChar: (length: number) => `varchar(${length})`,
    NVarChar: (length: number) => `nvarchar(${length})`,
  },
}));

describe("metrics run persistence", () => {
  it("requires a current published complete positive day with zero quarantine, not just a checkpoint", async () => {
    query.mockResolvedValue({ recordset: [{ complete: 1 }] });
    const store = createMetricsRunStore({ server: "fixture.invalid", database: "fixture" });
    await expect(store.isComplete(123, "2026-10-25")).resolves.toBe(true);
    const statement = query.mock.lastCall?.[0] as string;
    expect(statement).toMatch(/status\s*=\s*'published'/);
    expect(statement).toMatch(/is_current\s*=\s*1/);
    expect(statement).toMatch(/rows_read\s*=\s*rows_loaded/);
    expect(statement).toMatch(/rows_read\s*>\s*0/);
    expect(statement).toMatch(/rows_quarantined\s*=\s*0/);
    expect(statement).not.toContain("SourceCheckpoint");
    expect(input).toHaveBeenCalledWith("scopeKey", "nvarchar(100)", "123");
    expect(close).toHaveBeenCalled();
  });

  it("returns false for a missing complete day", async () => {
    query.mockResolvedValue({ recordset: [] });
    const store = createMetricsRunStore({ server: "fixture.invalid", database: "fixture" });
    await expect(store.isComplete(123, "2026-10-25")).resolves.toBe(false);
  });

  it("inserts a separate failed run without artifacts/checkpoint/audit mutations", async () => {
    query.mockResolvedValue({ recordset: [] });
    const store = createMetricsRunStore({ server: "fixture.invalid", database: "fixture" });
    await store.recordFailure({
      runId: "00000000-0000-4000-8000-000000000001",
      correlationId: "00000000-0000-4000-8000-000000000002",
      organizationId: 123, organizationLogin: "fixture-org", reportDay: "2026-10-25", errorCode: "report_gap",
    });
    const statement = query.mock.lastCall?.[0] as string;
    expect(statement).toContain("INSERT INTO portal.IngestionRun");
    expect(statement).toContain("'failed'");
    expect(statement).not.toMatch(/SourceCheckpoint|SourceArtifact|IngestionAuditEvent|UPDATE/);
  });

  it("closes connections and surfaces persistence errors", async () => {
    query.mockRejectedValueOnce(new Error("SQL unavailable"));
    const store = createMetricsRunStore({ server: "fixture.invalid", database: "fixture" });
    await expect(store.isComplete(123, "2026-10-25")).rejects.toThrow("SQL unavailable");
    expect(close).toHaveBeenCalled();
  });
});
