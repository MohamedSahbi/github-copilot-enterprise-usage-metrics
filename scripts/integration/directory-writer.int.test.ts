import { randomUUID } from "node:crypto";
import sql from "mssql";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectoryUserSchema } from "../../shared/src/directory-input";
import { createDirectorySqlWriter } from "../../functions/src/directory/sql-writer";
import { syncDirectory, type DirectoryCommit } from "../../functions/src/directory/sync";
import { SqlAccessRepository } from "../../portal/src/authz/sql-access";
import { openPool } from "./db";

const ids = [990075001, 990075002, 990075003, 990075004];
const oids = ids.map((_, index) => `00000000-0000-4000-8000-${String(7501 + index).padStart(12, "0")}`);
const scope = "directory-writer-integration";
const successAt = new Date("2026-03-01T00:00:00Z");
type State = { source: string; last_success_at: Date | null; last_attempt_at: Date | null; last_error_code: string | null };
let pool: sql.ConnectionPool;
let states: State[];

function command(failed: boolean, startedAt: Date): DirectoryCommit {
  const runId = randomUUID();
  const completedAt = new Date(startedAt.getTime() + 1_000).toISOString();
  const users = failed ? [] : ids.slice(1).map((userId, index) => ({
    user: DirectoryUserSchema.parse({
      user_id: userId, login: `directory-user-${userId}`, entra_object_id: oids[index + 1],
      entra_account_enabled: true, state: "active", manager_entra_object_id: oids[0],
      manager_email: "manager@example.invalid", department: "updated",
    }),
    managerResolved: true, errorCode: null,
  } as const));
  return {
    managerCheckUserIds: failed ? [ids[1]!] : ids.slice(1), users,
    run: {
      run_id: runId, source_kind: "directory", scope_key: scope, report_day: null,
      range_start: null, range_end: null, status: failed ? "failed" : "published", is_current: false,
      transform_version: "1", attempt: 1, rows_read: 3, rows_loaded: users.length, rows_quarantined: 0,
      error_code: failed ? "profile_read_failed" : null, correlation_id: runId,
      started_at: startedAt.toISOString(), completed_at: completedAt,
    },
    sync: (["scim", "seats", "graph"] as const).map((source) => ({
      source, last_attempt_at: completedAt,
      last_success_at: failed ? null : completedAt, last_error_code: failed ? "profile_read_failed" : null,
    })),
  };
}

async function users() {
  return (await pool.request().input("root", sql.BigInt, ids[0]!).query<{
    user_id: string; entra_object_id: string; manager_entra_object_id: string;
    manager_resolved: boolean; manager_checked_at: Date; department: string;
  }>(`SELECT user_id, entra_object_id, manager_entra_object_id, manager_resolved, manager_checked_at, department
      FROM portal.dim_user WHERE user_id > @root AND user_id <= @root + 3 ORDER BY user_id`)).recordset;
}

async function visibleReports() {
  return (await new SqlAccessRepository(pool).readScopedUsers(oids[0]!, [
    { role: "manager", scope: "team", scope_value: "" },
  ])).map(({ user_id }) => user_id).sort((a, b) => a - b);
}

async function expectNoSuccessfulPublication(runId: string) {
  const run = await pool.request().input("runId", sql.UniqueIdentifier, runId)
    .query("SELECT status, rows_loaded FROM portal.IngestionRun WHERE run_id = @runId");
  expect(run.recordset).toEqual([{ status: "failed", rows_loaded: 0 }]);
  const sync = await pool.request().query<State>("SELECT * FROM portal.DirectorySyncState WHERE source IN ('scim','seats','graph')");
  expect(sync.recordset).toHaveLength(3);
  expect(sync.recordset.every(({ last_success_at }) => last_success_at?.getTime() === successAt.getTime())).toBe(true);
}

describe("durable per-user directory evidence (real SQL)", () => {
  beforeAll(async () => { pool = await openPool(); });
  beforeEach(async () => {
    states = (await pool.request().query<State>("SELECT * FROM portal.DirectorySyncState WHERE source IN ('scim','seats','graph')")).recordset;
    await pool.request().query("DELETE FROM portal.DirectorySyncState WHERE source IN ('scim','seats','graph')");
    for (const source of ["scim", "seats", "graph"]) {
      await pool.request().input("source", sql.VarChar(16), source).input("success", sql.DateTime2, successAt)
        .query(`INSERT INTO portal.DirectorySyncState (source, last_success_at, last_attempt_at)
          VALUES (@source, @success, @success)`);
    }
    for (const [index, id] of ids.entries()) {
      await pool.request().input("id", sql.BigInt, id).input("oid", sql.UniqueIdentifier, oids[index]!)
        .input("manager", sql.UniqueIdentifier, index ? oids[0]! : null)
        .query(`INSERT INTO portal.dim_user (user_id, login, entra_object_id, manager_entra_object_id,
            manager_email, department, manager_resolved, manager_checked_at)
          VALUES (@id, CONCAT('directory-user-', @id), @oid, @manager,
            CASE WHEN @manager IS NULL THEN NULL ELSE N'manager@example.invalid' END,
            N'baseline', 1, DATEADD(second, -1, SYSUTCDATETIME()))`);
    }
  });
  afterEach(async () => {
    await pool.request().input("root", sql.BigInt, ids[0]!).input("scope", sql.NVarChar(100), scope)
      .query(`DELETE FROM portal.dim_user WHERE user_id BETWEEN @root AND @root + 3;
        DELETE FROM portal.IngestionRun WHERE source_kind = 'directory' AND scope_key = @scope;
        DELETE FROM portal.DirectorySyncState WHERE source IN ('scim','seats','graph')`);
    for (const state of states) {
      await pool.request().input("source", sql.VarChar(16), state.source)
        .input("success", sql.DateTime2, state.last_success_at).input("attempt", sql.DateTime2, state.last_attempt_at)
        .input("error", sql.VarChar(64), state.last_error_code)
        .query(`INSERT INTO portal.DirectorySyncState (source, last_success_at, last_attempt_at, last_error_code)
          VALUES (@source, @success, @attempt, @error)`);
    }
  });
  afterAll(async () => { await pool.close(); });

  it("keeps a failed lookup denied despite another profile's immutable identity conflict, without hiding a valid sibling", async () => {
    const conflictingOid = "00000000-0000-4000-8000-000000007599";
    const externalIds = [oids[1]!, conflictingOid, oids[3]!];
    const runId = randomUUID();
    await expect(syncDirectory({
      provider: "entra", enterprise: scope, organizations: ["fixture-org"], runId,
      attributes: { departmentAttribute: "", businessAreaAttribute: "" },
    }, {
      now: () => new Date(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      writer: createDirectorySqlWriter(() => new sql.Transaction(pool)),
      github: async (path) => path.startsWith("/scim/") ? { status: 200, body: {
        totalResults: 3, startIndex: 1, itemsPerPage: 3, Resources: externalIds.map((externalId, index) => ({
          externalId, active: true, profileUrl: `https://github.com/directory-user-${ids[index + 1]}`,
        })),
      } } : { status: 200, body: { total_seats: 3, seats: ids.slice(1).map((id) => ({
        assignee: { id, login: `directory-user-${id}` },
      })) } },
      graph: async (path) => {
        if (path.includes(oids[1]!)) return { status: 403, body: null };
        if (path.includes("/manager?")) return { status: 200, body: { id: oids[0], mail: "manager@example.invalid" } };
        return { status: 200, body: { id: path.includes(conflictingOid) ? conflictingOid : oids[3], accountEnabled: true } };
      },
    })).rejects.toThrow("directory_write_failed");
    const rows = await users();
    expect(rows.map(({ manager_resolved }) => manager_resolved)).toEqual([false, false, true]);
    expect(rows.map(({ entra_object_id }) => entra_object_id.toLowerCase())).toEqual(oids.slice(1));
    expect(rows.every(({ manager_entra_object_id, department }) =>
      manager_entra_object_id.toLowerCase() === oids[0] && department === "baseline")).toBe(true);
    expect(await visibleReports()).toEqual([ids[3]]);
    expect(await new SqlAccessRepository(pool).readScopedUsers(oids[1]!, [
      { role: "user", scope: "self", scope_value: "" },
    ])).toMatchObject([{ user_id: ids[1] }]);
    await expectNoSuccessfulPublication(runId);
  });

  it.each(["between phases", "during publication"] as const)("retains negatives and prior successful siblings on an exception %s", async (stage) => {
    const attempt = command(false, new Date(Date.now() - 10_000));
    attempt.users = attempt.users.slice(1);
    attempt.run.status = "failed";
    attempt.run.error_code = "profile_read_failed";
    attempt.run.rows_loaded = attempt.users.length;
    attempt.sync = attempt.sync.map((state) => ({ ...state, last_success_at: null, last_error_code: "profile_read_failed" }));
    let count = 0;
    const writer = createDirectorySqlWriter(() => {
      const transaction = new sql.Transaction(pool);
      if (++count === 2) {
        if (stage === "between phases") vi.spyOn(transaction, "begin").mockRejectedValue(new Error("synthetic phase boundary failure"));
        else vi.spyOn(transaction, "commit").mockImplementation(async () => {
          await transaction.request().query("THROW 51000, 'SYNTHETIC_PUBLICATION_FAILURE', 1");
        });
      }
      return transaction;
    });
    const before = await users();
    await expect(writer.commit(attempt)).rejects.toThrow("directory_write_failed");
    const after = await users();
    expect(after.map(({ manager_resolved }) => manager_resolved)).toEqual([false, true, true]);
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(await visibleReports()).toEqual(ids.slice(2));
    await expectNoSuccessfulPublication(attempt.run.run_id);
  });

  it("rejects older negative evidence and equal-second retries after a newer success", async () => {
    const startedAt = new Date(Date.now() - 10_000);
    const writer = createDirectorySqlWriter(() => new sql.Transaction(pool));
    const newer = command(false, new Date(startedAt.getTime() + 2_000));
    await writer.commit(newer);
    const before = await users();
    await expect(writer.commit(command(true, startedAt))).rejects.toThrow("directory_write_failed");
    await expect(writer.commit(newer)).rejects.toThrow("directory_write_failed");
    expect(await users()).toEqual(before);
    expect(await visibleReports()).toEqual(ids.slice(1));
  });

  it("does not restore older positive evidence after a newer negative reservation", async () => {
    const startedAt = new Date(Date.now() - 10_000);
    const newer = command(true, new Date(startedAt.getTime() + 2_000));
    const newerWriter = createDirectorySqlWriter(() => new sql.Transaction(pool));
    let count = 0;
    const olderWriter = createDirectorySqlWriter(() => {
      const transaction = new sql.Transaction(pool);
      if (++count === 1) {
        const commit = transaction.commit.bind(transaction);
        vi.spyOn(transaction, "commit").mockImplementation(async () => {
          await commit();
          await newerWriter.commit(newer);
        });
      }
      return transaction;
    });
    await expect(olderWriter.commit(command(false, startedAt))).rejects.toThrow("directory_write_failed");
    expect((await users()).map(({ manager_resolved }) => manager_resolved)).toEqual([false, true, true]);
    expect(await visibleReports()).toEqual(ids.slice(2));
    await expectNoSuccessfulPublication(newer.run.run_id);
  });
});
