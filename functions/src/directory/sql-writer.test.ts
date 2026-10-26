import { describe, expect, it, vi } from "vitest";
import sql from "mssql";
import { createDirectorySqlWriter } from "./sql-writer.js";
import { DirectoryUserSchema } from "../../../shared/src/directory-input.js";
import type { DirectoryCommit } from "./sync.js";

const now = "2026-10-26T12:00:00.000Z";
const command: DirectoryCommit = {
  run: {
    run_id: "00000000-0000-0000-0000-000000000003", source_kind: "directory", scope_key: "fixture-enterprise",
    report_day: null, range_start: null, range_end: null, status: "failed", is_current: false, transform_version: "1",
    attempt: 1, rows_read: 1, rows_loaded: 1, rows_quarantined: 0, error_code: "manager_read_failed",
    correlation_id: "00000000-0000-0000-0000-000000000003", started_at: now, completed_at: now,
  },
  users: [{ user: DirectoryUserSchema.parse({
    user_id: 42, entra_object_id: "00000000-0000-0000-0000-000000000001", entra_account_enabled: true, state: "active",
  }), managerResolved: false, errorCode: "manager_read_failed" }],
  sync: [{ source: "graph", last_success_at: null, last_attempt_at: now, last_error_code: "manager_read_failed" }],
};

function setup(failOn: "user" | "run" | "state" | "commit" | null = null, lockResult = 0) {
  const transaction = new sql.Transaction();
  const statements: string[] = [];
  const requests: sql.Request[] = [];
  const begin = vi.spyOn(transaction, "begin").mockResolvedValue(transaction);
  const commit = vi.spyOn(transaction, "commit").mockResolvedValue(undefined);
  if (failOn === "commit") commit.mockRejectedValue(new Error("private-commit@example.invalid"));
  const rollback = vi.spyOn(transaction, "rollback").mockResolvedValue(undefined);
  vi.spyOn(transaction, "request").mockImplementation(() => {
    const request = new sql.Request(transaction);
    requests.push(request);
    vi.spyOn(request, "query").mockImplementation((text: string | TemplateStringsArray) => {
      statements.push(String(text));
      const failureStatement = failOn === "user" ? "UPDATE portal.dim_user"
        : failOn === "run" ? "INSERT INTO portal.IngestionRun"
          : failOn === "state" ? "UPDATE portal.DirectorySyncState" : null;
      if (failureStatement && String(text).includes(failureStatement)) return Promise.reject(new Error("private-row@example.invalid"));
      return Promise.resolve({ recordset: [{ result: lockResult }], recordsets: [], output: {}, rowsAffected: [] });
    });
    return request;
  });
  return { transaction, statements, requests, begin, commit, rollback, writer: createDirectorySqlWriter(() => transaction) };
}

describe("directory SQL transaction", () => {
  it("commits run, current hierarchy and freshness in one serializable transaction", async () => {
    const fake = setup();
    await fake.writer.commit(command);
    expect(fake.begin).toHaveBeenCalledWith(sql.ISOLATION_LEVEL.SERIALIZABLE);
    expect(fake.commit).toHaveBeenCalledOnce();
    expect(fake.rollback).not.toHaveBeenCalled();
    expect(fake.statements[0]).toContain("sp_getapplock");
    expect(fake.statements.some((text) => text.includes("INSERT INTO portal.IngestionRun"))).toBe(true);
    expect(fake.statements.some((text) => text.includes("UPDATE portal.dim_user"))).toBe(true);
    const state = fake.statements.find((text) => text.includes("UPDATE portal.DirectorySyncState"));
    expect(state).toContain("COALESCE(@lastSuccess, last_success_at)");
    expect(fake.requests.find((request) => request.parameters.source)?.parameters.lastSuccess?.value).toBe(null);
    expect(fake.statements.join("\n")).not.toMatch(/dbo\.|portal\.Principal|GrantRevocation|GRANT |DELETE/);
  });

  it("rolls back every user/state/run write on SQL failure and sanitizes errors", async () => {
    const fake = setup("user");
    await expect(fake.writer.commit(command)).rejects.toThrow("directory_write_failed");
    expect(fake.commit).not.toHaveBeenCalled();
    expect(fake.rollback).toHaveBeenCalledOnce();
    expect(fake.statements.some((text) => text.includes("UPDATE portal.DirectorySyncState"))).toBe(false);
  });

  it("never writes anything after failing to acquire the directory lock", async () => {
    const fake = setup(null, -1);
    await expect(fake.writer.commit(command)).rejects.toThrow("directory_write_failed");
    expect(fake.statements).toHaveLength(1);
    expect(fake.rollback).toHaveBeenCalledOnce();
  });

  it.each(["run", "state", "commit"] as const)("rolls back on %s failure instead of committing partial state", async (stage) => {
    const fake = setup(stage);
    await expect(fake.writer.commit(command)).rejects.toThrow("directory_write_failed");
    expect(fake.rollback).toHaveBeenCalledOnce();
    if (stage !== "commit") expect(fake.commit).not.toHaveBeenCalled();
  });

  it("rejects equal-second snapshot ordering because existing freshness timestamps lose subsecond order", async () => {
    const fake = setup();
    await fake.writer.commit(command);
    expect(fake.statements[0]).toContain("@LockOwner = 'Transaction'");
    const stateWrite = fake.statements.find((text) => text.includes("UPDATE portal.DirectorySyncState"));
    expect(stateWrite).toContain("last_attempt_at < CONVERT(datetime2(0), @startedAt)");
    expect(stateWrite).toContain("DIRECTORY_STALE_SNAPSHOT");
    expect(fake.statements.some((text) => text.includes("IF EXISTS") && !text.includes("UPDATE"))).toBe(false);
  });
});
