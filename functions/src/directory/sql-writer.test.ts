import { describe, expect, it, vi } from "vitest";
import sql from "mssql";
import { createDirectorySqlWriter } from "./sql-writer.js";
import { DirectoryUserSchema } from "../../../shared/src/directory-input.js";
import type { DirectoryCommit } from "./sync.js";

const now = "2026-10-26T12:00:00.000Z";
const command: DirectoryCommit = {
  managerCheckUserIds: [42],
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

type Failure = "reservation" | "invalidation" | "ownership" | "user" | "state" | "run" | "commit";
function setup(failOn: Failure | null = null, failPhase = 0, lockResult = 0, conflicts: number[] = [], tenant?: string) {
  function phase(index: number) {
    const transaction = new sql.Transaction();
    const statements: string[] = [];
    const requests: sql.Request[] = [];
    const begin = vi.spyOn(transaction, "begin").mockResolvedValue(transaction);
    const commit = vi.spyOn(transaction, "commit").mockResolvedValue(undefined);
    if (failOn === "commit" && index === failPhase) commit.mockRejectedValue(new Error("private-commit@example.invalid"));
    const rollback = vi.spyOn(transaction, "rollback").mockResolvedValue(undefined);
    vi.spyOn(transaction, "request").mockImplementation(() => {
      const request = new sql.Request(transaction);
      requests.push(request);
      vi.spyOn(request, "query").mockImplementation((text: string | TemplateStringsArray) => {
        const query = String(text);
        statements.push(query);
        const failureStatement = {
          reservation: "INSERT INTO portal.IngestionRun", invalidation: "manager_resolved = 0",
          ownership: "DECLARE @owner", user: "DIRECTORY_IDENTITY_CONFLICT",
          state: "UPDATE portal.DirectorySyncState", run: "UPDATE portal.IngestionRun", commit: "",
        }[failOn ?? "commit"];
        if (failOn && failureStatement && index === failPhase && query.includes(failureStatement)) {
          return Promise.reject(new Error("private-row@example.invalid"));
        }
        const recordset = query.includes("sp_getapplock") ? [{ result: lockResult }]
          : query.includes("SELECT candidate.user_id") ? conflicts.map((user_id) => ({ user_id })) : [];
        return Promise.resolve({ recordset, recordsets: [], output: {}, rowsAffected: [] });
      });
      return request;
    });
    return { transaction, statements, requests, begin, commit, rollback };
  }
  const phases = [phase(0), phase(1), phase(2)];
  let nextPhase = 0;
  const createTransaction = vi.fn(() => phases[nextPhase++]!.transaction);
  return { phases, createTransaction, writer: createDirectorySqlWriter(createTransaction, { entraTenantId: tenant }) };
}

describe("directory SQL evidence and publication transactions", () => {
  it("applies soft revocation only for a published run with a configured tenant", async () => {
    const tenant = "00000000-0000-4000-8000-000000000009";
    const suspended = DirectoryUserSchema.parse({ ...command.users[0]!.user, entra_account_enabled: false, state: "suspended" });
    const published = {
      ...command,
      users: [{ ...command.users[0]!, user: suspended }],
      run: { ...command.run, status: "published" as const, error_code: null },
    };
    const withTenant = setup(null, 0, 0, [], tenant);
    await withTenant.writer.commit(published);
    expect(withTenant.phases[1]!.statements.join("\n")).toContain("INSERT INTO portal.GrantRevocation");
    const withoutTenant = setup();
    await withoutTenant.writer.commit(published);
    expect(withoutTenant.phases[1]!.statements.join("\n")).not.toContain("GrantRevocation");
    const failed = setup(null, 0, 0, [], tenant);
    await failed.writer.commit({ ...command, users: published.users });
    expect(failed.phases[1]!.statements.join("\n")).not.toContain("GrantRevocation");
  });

  it("commits negatives first, then atomically publishes profiles/run/success under the same lock", async () => {
    const fake = setup();
    await fake.writer.commit(command);
    expect(fake.createTransaction).toHaveBeenCalledTimes(2);
    for (const phase of fake.phases.slice(0, 2)) {
      expect(phase.begin).toHaveBeenCalledWith(sql.ISOLATION_LEVEL.SERIALIZABLE);
      expect(phase.commit).toHaveBeenCalledOnce();
      expect(phase.rollback).not.toHaveBeenCalled();
      expect(phase.statements[0]).toContain("@Resource = N'ingest:directory'");
      expect(phase.statements[0]).toContain("@LockOwner = 'Transaction'");
    }
    const [negative, publication] = fake.phases;
    expect(negative!.statements.join("\n")).toContain("manager_resolved = 0");
    expect(negative!.statements.join("\n")).not.toContain("SET last_success_at");
    expect(publication!.statements.join("\n")).toContain("DIRECTORY_IDENTITY_CONFLICT");
    expect(publication!.statements.join("\n")).toContain("COALESCE(@lastSuccess, last_success_at)");
    expect(publication!.statements.join("\n")).toContain("UPDATE portal.IngestionRun");
    expect(fake.phases.flatMap(({ statements }) => statements).join("\n"))
      .not.toMatch(/dbo\.|portal\.Principal|GrantRevocation|GRANT |DELETE/);
  });

  it("invalidates only missing/unresolved/conflicting users, leaving successful siblings alone", async () => {
    const fake = setup();
    await fake.writer.commit({
      ...command, managerCheckUserIds: [42, 43, 44],
      users: [...command.users, { ...command.users[0]!, user: { ...command.users[0]!.user, user_id: 44 }, managerResolved: true, errorCode: null }],
    });
    const negative = fake.phases[0]!;
    const request = negative.requests.find(({ parameters }) => parameters.unresolvedIds);
    expect(request?.parameters.unresolvedIds?.value).toBe("[42,43]");
    const query = negative.statements.find((text) => text.includes("manager_resolved = 0"));
    expect(query).not.toMatch(/manager_entra_object_id\s*=|manager_email\s*=/);
    expect(query).toContain("manager_checked_at = SYSUTCDATETIME()");
  });

  it("persists classified conflicts as a genuine failed attempt without publishing a profile", async () => {
    const fake = setup(null, 0, 0, [42]);
    await expect(fake.writer.commit(command)).rejects.toThrow("directory_write_failed");
    expect(fake.phases[0]!.commit).toHaveBeenCalledOnce();
    expect(fake.createTransaction).toHaveBeenCalledOnce();
    const run = fake.phases[0]!.requests.find(({ parameters }) => parameters.status);
    expect(run?.parameters.status?.value).toBe("failed");
    expect(run?.parameters.errorCode?.value).toBe("manager_read_failed");
  });

  it("records an all-successful read as started, not a fictional completed failure", async () => {
    const fake = setup();
    await fake.writer.commit({
      ...command, run: { ...command.run, status: "published", error_code: null },
      users: command.users.map((profile) => ({ ...profile, managerResolved: true, errorCode: null })),
      sync: command.sync.map((state) => ({ ...state, last_success_at: now, last_error_code: null })),
    });
    const run = fake.phases[0]!.requests.find(({ parameters }) => parameters.status);
    expect(run?.parameters.status?.value).toBe("started");
    expect(run?.parameters.errorCode?.value).toBeNull();
    expect(run?.parameters.completedAt?.value).toBeNull();
    expect(fake.phases[0]!.statements.join("\n")).not.toContain("manager_resolved = 0");
  });

  it.each(["reservation", "invalidation", "state", "commit"] as const)("never publishes when negative phase %s fails", async (stage) => {
    const fake = setup(stage);
    await expect(fake.writer.commit(command)).rejects.toThrow("directory_write_failed");
    expect(fake.createTransaction).toHaveBeenCalledOnce();
    expect(fake.phases[0]!.rollback).toHaveBeenCalledOnce();
  });

  it.each(["ownership", "user", "state", "run", "commit"] as const)("retains committed negatives when publication %s fails", async (stage) => {
    const fake = setup(stage, 1);
    await expect(fake.writer.commit(command)).rejects.toThrow("directory_write_failed");
    expect(fake.phases[0]!.commit).toHaveBeenCalledOnce();
    expect(fake.phases[0]!.rollback).not.toHaveBeenCalled();
    expect(fake.phases[1]!.rollback).toHaveBeenCalledOnce();
    if (stage !== "commit") expect(fake.phases[1]!.commit).not.toHaveBeenCalled();
  });

  it("marks a reserved run failed when publication fails, instead of leaving it started forever", async () => {
    const fake = setup("user", 1);
    await expect(fake.writer.commit({
      ...command, run: { ...command.run, status: "published", error_code: null },
      users: command.users.map((profile) => ({ ...profile, managerResolved: true, errorCode: null })),
      sync: command.sync.map((state) => ({ ...state, last_success_at: now, last_error_code: null })),
    })).rejects.toThrow("directory_write_failed");
    const recovery = fake.phases[2]!.statements.join("\n");
    expect(recovery).toContain("SET status = 'failed', error_code = 'directory_write_failed'");
    expect(recovery).toContain("WHERE run_id = @runId AND status = 'started'");
    expect(recovery).toContain("last_error_code IS NULL");
    expect(fake.phases[2]!.commit).toHaveBeenCalledOnce();
  });

  it("still reports the publication failure when the recovery write fails too", async () => {
    const fake = setup("user", 1);
    vi.spyOn(fake.phases[2]!.transaction, "commit").mockRejectedValue(new Error("private-recovery@example.invalid"));
    await expect(fake.writer.commit(command)).rejects.toThrow("directory_write_failed");
    expect(fake.phases[2]!.rollback).toHaveBeenCalledOnce();
  });

  it("writes nothing after failing to acquire the directory lock", async () => {
    const fake = setup(null, 0, -1);
    await expect(fake.writer.commit(command)).rejects.toThrow("directory_write_failed");
    expect(fake.phases[0]!.statements).toHaveLength(1);
    expect(fake.phases[0]!.rollback).toHaveBeenCalledOnce();
    expect(fake.createTransaction).toHaveBeenCalledOnce();
  });

  it("guards strict ordering and exact run/source reservation ownership rather than timestamp equality alone", async () => {
    const fake = setup();
    await fake.writer.commit(command);
    const first = fake.phases[0]!.statements.join("\n");
    expect(first).toContain("started_at >= CONVERT(datetime2(0), @startedAt)");
    expect(first).toContain("last_attempt_at < CONVERT(datetime2(0), @startedAt)");
    const second = fake.phases[1]!.statements.find((text) => text.includes("DECLARE @owner"));
    expect(second).toContain("@owner <> @runId");
    expect(second).toContain("ORDER BY started_at DESC, run_id DESC");
    expect(second).toContain("OPENJSON(@sources)");
    expect(second).toContain("DIRECTORY_STALE_SNAPSHOT");
  });
});
