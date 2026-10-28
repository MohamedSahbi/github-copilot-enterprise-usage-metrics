import { randomUUID } from "node:crypto";
import sql from "mssql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../db/migrate";
import { localConnectionString } from "../stack/config";
import { AUTH_OBJECTS_BY_PERSONA, AUTH_TENANT, seedAuth } from "./auth-seed";
import { createDirectorySqlWriter } from "../../functions/src/directory/sql-writer";
import type { DirectoryCommit } from "../../functions/src/directory/sync";
import { DirectoryUserSchema } from "../../shared/src/directory-input";
import type { BudgetLookupRequest } from "../../shared/src/api";
import { resolveBudgetLookupAccess } from "../../portal/src/budget/access";
import type { Identity } from "../../portal/src/authz/access";

const mocks = vi.hoisted(() => ({
  getPortalSqlPool: vi.fn(),
}));

vi.mock("../../portal/src/db/pool", () => ({ getPortalSqlPool: mocks.getPortalSqlPool }));

const TEST_SQL_PORT = "14335";
const database = `budget_lookup_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const connectionString = localConnectionString({ LOCAL_SQL_PORT: TEST_SQL_PORT }, database);
const enterprise = "example-budget-enterprise";
const userIds = [990085001, 990085002, 990085003, 990085004];
const objectIds = Object.values(AUTH_OBJECTS_BY_PERSONA);
const directorySources = ["scim", "seats", "graph"] as const;
const selfRequest = { target: "self" } as const;
let pool: sql.ConnectionPool | undefined;
let master: sql.ConnectionPool | undefined;
let databaseCreated = false;
let baselineStartedAt: Date;
let baselineCompletedAt: Date;

function personaIdentity(persona: keyof typeof AUTH_OBJECTS_BY_PERSONA): Identity {
  return {
    provider: "entra",
    tenantId: AUTH_TENANT,
    objectId: AUTH_OBJECTS_BY_PERSONA[persona],
    groups: [],
  };
}

function currentSecond(date = new Date()): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

function resolveForPersona(
  persona: keyof typeof AUTH_OBJECTS_BY_PERSONA,
  request: BudgetLookupRequest = selfRequest,
  now = new Date(),
) {
  return resolveBudgetLookupAccess("synthetic-correlation", personaIdentity(persona), request, now);
}

async function insertRun(input: {
  id?: string;
  scope?: string;
  status: "started" | "published" | "failed";
  startedAt: Date;
  completedAt: Date | null;
  errorCode?: string | null;
}): Promise<string> {
  const runId = input.id ?? randomUUID();
  const correlationId = randomUUID();
  await pool!.request()
    .input("runId", sql.UniqueIdentifier, runId)
    .input("correlationId", sql.VarChar(64), correlationId)
    .input("scope", sql.NVarChar(100), input.scope ?? enterprise)
    .input("status", sql.VarChar(16), input.status)
    .input("startedAt", sql.DateTime2(0), input.startedAt)
    .input("completedAt", sql.DateTime2(0), input.completedAt)
    .input("errorCode", sql.VarChar(64), input.errorCode ?? null)
    .query(`
      INSERT INTO portal.IngestionRun (
        run_id, source_kind, scope_key, report_day, status, is_current, transform_version,
        rows_read, rows_loaded, rows_quarantined, error_code, correlation_id, started_at, completed_at
      ) VALUES (
        @runId, 'directory', @scope, NULL, @status, 0, '1',
        4, 4, 0, @errorCode, @correlationId, @startedAt, @completedAt
      )`);
  return runId;
}

async function setSourceEvidence(
  completedAt: Date,
  sources: readonly string[] = directorySources,
  errorCode: string | null = null,
  successAt: Date = completedAt,
): Promise<void> {
  for (const source of sources) {
    await pool!.request()
      .input("source", sql.VarChar(16), source)
      .input("at", sql.DateTime2(0), completedAt)
      .input("errorCode", sql.VarChar(64), errorCode)
      .input("successAt", sql.DateTime2(0), successAt)
      .query(`
        UPDATE portal.DirectorySyncState
        SET last_attempt_at = @at, last_success_at = @successAt, last_error_code = @errorCode
        WHERE source = @source;
        IF @@ROWCOUNT = 0
          INSERT INTO portal.DirectorySyncState (source, last_success_at, last_attempt_at, last_error_code)
          VALUES (@source, @successAt, @at, @errorCode)`);
  }
}

async function createBaseline(): Promise<void> {
  const stamp = currentSecond(new Date(Date.now() - 30_000));
  baselineStartedAt = stamp;
  baselineCompletedAt = stamp;
  await insertRun({ status: "published", startedAt: stamp, completedAt: stamp });
  await setSourceEvidence(stamp);

  for (const [index, persona] of Object.keys(AUTH_OBJECTS_BY_PERSONA).entries()) {
    const managerId = persona === "member" ? AUTH_OBJECTS_BY_PERSONA.manager : null;
    await pool!.request()
      .input("userId", sql.BigInt, userIds[index]!)
      .input("login", sql.NVarChar(255), `synthetic-${persona}`)
      .input("oid", sql.UniqueIdentifier, objectIds[index]!)
      .input("manager", sql.UniqueIdentifier, managerId)
      .query(`
        INSERT INTO portal.dim_user (
          user_id, login, entra_object_id, manager_entra_object_id, manager_email,
          department, business_area, manager_resolved, manager_checked_at
        ) VALUES (
          @userId, @login, @oid, @manager,
          CASE WHEN @manager IS NULL THEN NULL ELSE N'manager@example.invalid' END,
          N'synthetic', N'test', 1, DATEADD(second, -1, SYSUTCDATETIME())
        )`);
  }
}

function failedPartialCommit(startedAt: Date): DirectoryCommit {
  const user = DirectoryUserSchema.parse({
    user_id: userIds[0],
    login: "synthetic-admin-updated",
    entra_object_id: objectIds[0],
    entra_account_enabled: true,
    state: "active",
    email: "admin@example.invalid",
    display_name: "Synthetic Admin",
    manager_entra_object_id: null,
    manager_email: null,
    department: "partial-update",
    business_area: "test",
  });
  const runId = randomUUID();
  const completedAt = new Date(startedAt.getTime() + 1_000).toISOString();
  return {
    managerCheckUserIds: [user.user_id],
    users: [{ user, managerResolved: true, errorCode: null }],
    run: {
      run_id: runId,
      source_kind: "directory",
      scope_key: enterprise,
      report_day: null,
      range_start: null,
      range_end: null,
      status: "failed",
      is_current: false,
      transform_version: "1",
      attempt: 1,
      rows_read: 4,
      rows_loaded: 1,
      rows_quarantined: 0,
      error_code: "profile_read_failed",
      correlation_id: runId,
      started_at: startedAt.toISOString(),
      completed_at: completedAt,
    },
    sync: directorySources.map((source) => ({
      source,
      last_attempt_at: completedAt,
      last_success_at: null,
      last_error_code: "profile_read_failed",
    })),
  };
}

function successfulDirectoryCommit(startedAt: Date): DirectoryCommit {
  const candidate = failedPartialCommit(startedAt);
  const completedAt = new Date(startedAt.getTime() + 1_000).toISOString();
  return {
    ...candidate,
    run: { ...candidate.run, status: "published", error_code: null },
    sync: directorySources.map((source) => ({
      source,
      last_attempt_at: completedAt,
      last_success_at: completedAt,
      last_error_code: null,
    })),
  };
}

async function insertLatestStatus(
  status: "started" | "published" | "failed",
  startedAt = new Date(baselineStartedAt.getTime() + 2_000),
  completedAt: Date | null = status === "started" ? null : new Date(startedAt.getTime() + 1_000),
  errorCode: string | null = status === "failed" ? "profile_read_failed" : null,
): Promise<string> {
  const runId = await insertRun({ status, startedAt, completedAt, errorCode });
  if (completedAt) {
    await setSourceEvidence(
      completedAt,
      directorySources,
      errorCode,
      status === "failed" ? baselineCompletedAt : completedAt,
    );
  }
  return runId;
}

async function expectUnavailable(
  persona: keyof typeof AUTH_OBJECTS_BY_PERSONA = "admin",
  now = new Date(),
): Promise<void> {
  await expect(resolveForPersona(persona, selfRequest, now))
    .resolves.toEqual({ state: "permissions_unavailable" });
}

async function waitForLockWait(blockingSessionId: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool!.request()
      .input("blockingSessionId", sql.Int, blockingSessionId)
      .query<{ session_id: number }>(`
        SELECT TOP (1) session_id
        FROM sys.dm_exec_requests
        WHERE blocking_session_id = @blockingSessionId
          AND wait_type LIKE 'LCK_%'`);
    if (result.recordset.length) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The Budget reader did not wait on the in-flight directory publication.");
}

async function waitBounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe.skipIf(process.env.RUN_BUDGET_SQL_TESTS !== "1")("Budget Lookup directory authorization (dedicated SQL)", () => {
  beforeAll(async () => {
    if (process.env.LOCAL_SQL_PORT !== TEST_SQL_PORT) {
      throw new Error(`Set LOCAL_SQL_PORT=${TEST_SQL_PORT} after the dedicated SQL port is allocated.`);
    }
    master = await new sql.ConnectionPool(localConnectionString({ LOCAL_SQL_PORT: TEST_SQL_PORT }, "master")).connect();
    const existing = await master.request().input("database", sql.NVarChar(128), database)
      .query<{ database_id: number | null }>("SELECT DB_ID(@database) AS database_id");
    if (existing.recordset[0]?.database_id !== null) {
      throw new Error("The generated Budget Lookup test database name already exists.");
    }
    await master.request().input("database", sql.NVarChar(128), database).query(`
      DECLARE @create nvarchar(max) = N'CREATE DATABASE ' + QUOTENAME(@database);
      EXEC(@create)`);
    databaseCreated = true;
    await migrate({ connectionString });
    pool = await new sql.ConnectionPool(connectionString).connect();
    mocks.getPortalSqlPool.mockResolvedValue(pool);
  }, 240_000);

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv("MODULE_BUDGET_LOOKUP", "true");
    vi.stubEnv("ENTERPRISE_SLUG", enterprise);
    vi.stubEnv("DIRECTORY_PROVIDER", "entra");
    vi.stubEnv("PER_USER_DETAIL_ENABLED", "false");
    vi.stubEnv("STALE_DATA_THRESHOLD_HOURS", "36");
    mocks.getPortalSqlPool.mockResolvedValue(pool);

    await pool!.request().query(`
      DELETE FROM portal.IngestionRun WHERE source_kind = 'directory';
      DELETE FROM portal.DirectorySyncState;
      DELETE FROM portal.dim_user`);
    await seedAuth(pool!);
    await createBaseline();
  });

  afterAll(async () => {
    if (pool) await pool.close();
    if (master && databaseCreated) {
      await master.request().input("database", sql.NVarChar(128), database).query(`
        DECLARE @drop nvarchar(max);
        IF DB_ID(@database) IS NOT NULL
        BEGIN
          SET @drop = N'ALTER DATABASE ' + QUOTENAME(@database) + N' SET SINGLE_USER WITH ROLLBACK IMMEDIATE';
          EXEC(@drop);
          SET @drop = N'DROP DATABASE ' + QUOTENAME(@database);
          EXEC(@drop);
        END`);
    }
    if (master) await master.close();
    vi.unstubAllEnvs();
  });

  it("allows self through the existing immutable principal and grant with per-user detail disabled", async () => {
    const result = await resolveForPersona("member");
    expect(result).toEqual({ state: "authorized", userId: userIds[2], login: "synthetic-member" });
  });

  it("denies a numeric user outside the existing grant population", async () => {
    const result = await resolveForPersona("member", { target: "user", userId: userIds[0]! });
    expect(result).toEqual({ state: "denied", code: "forbidden" });
  });

  it("keeps the existing self-only exception and enforces detail opt-in for other targets", async () => {
    const disabled = await resolveForPersona("admin", { target: "user", userId: userIds[2]! });
    expect(disabled).toEqual({ state: "denied", code: "per_user_detail_disabled" });

    vi.stubEnv("PER_USER_DETAIL_ENABLED", "true");
    const enabled = await resolveForPersona("admin", { target: "user", userId: userIds[2]! });
    expect(enabled).toEqual({ state: "authorized", userId: userIds[2], login: "synthetic-member" });
  });

  it("uses only the manager's current report population for non-self targets", async () => {
    vi.stubEnv("PER_USER_DETAIL_ENABLED", "true");
    await expect(resolveForPersona("manager", { target: "user", userId: userIds[2]! }))
      .resolves.toEqual({ state: "authorized", userId: userIds[2], login: "synthetic-member" });

    await expect(resolveForPersona("manager", { target: "user", userId: userIds[0]! }))
      .resolves.toEqual({ state: "denied", code: "forbidden" });
  });

  it("does not open SQL when the module flag is off", async () => {
    vi.stubEnv("MODULE_BUDGET_LOOKUP", "false");
    const result = await resolveForPersona("admin");
    expect(result).toEqual({ state: "denied", code: "module_disabled" });
    expect(mocks.getPortalSqlPool).not.toHaveBeenCalled();
  });

  it("fails closed after the real writer commits a failed partial profile update", async () => {
    const candidate = failedPartialCommit(new Date(baselineStartedAt.getTime() + 2_000));
    await createDirectorySqlWriter(() => new sql.Transaction(pool!)).commit(candidate);
    const changed = await pool!.request().input("id", sql.BigInt, userIds[0]!)
      .query<{ department: string }>("SELECT department FROM portal.dim_user WHERE user_id = @id");
    expect(changed.recordset).toEqual([{ department: "partial-update" }]);
    await expectUnavailable();
  });

  it.each([
    ["newer started reservation", async () => { await insertLatestStatus("started"); }],
    ["newer failed publication", async () => { await insertLatestStatus("failed"); }],
    ["wrong-scope latest run", async () => {
      await insertRun({
        scope: "different-enterprise",
        status: "published",
        startedAt: new Date(baselineStartedAt.getTime() + 2_000),
        completedAt: new Date(baselineStartedAt.getTime() + 3_000),
      });
    }],
    ["missing required source row", async () => {
      await insertLatestStatus("published");
      await pool!.request().query("DELETE FROM portal.DirectorySyncState WHERE source = 'graph'");
    }],
    ["provider/source mismatch", async () => {
      await insertLatestStatus("published");
      vi.stubEnv("DIRECTORY_PROVIDER", "csv");
    }],
  ])("rejects %s without falling back to an older publication", async (_label, arrange) => {
    await arrange();
    await expectUnavailable();
  });

  it.each([
    ["stale", -37 * 3_600_000],
    ["too-far future", 2_000],
  ])("rejects a %s latest publication", async (_label, offsetMs) => {
    const now = currentSecond();
    const stamp = new Date(now.getTime() + offsetMs);
    if (_label === "stale") {
      await pool!.request().input("startedAt", sql.DateTime2(0), stamp)
        .input("completedAt", sql.DateTime2(0), stamp)
        .query(`UPDATE portal.IngestionRun SET started_at = @startedAt, completed_at = @completedAt
          WHERE source_kind = 'directory'`);
    } else {
      await insertRun({
        status: "published",
        startedAt: new Date(now.getTime() - 1_000),
        completedAt: stamp,
      });
    }
    await setSourceEvidence(stamp);
    await expectUnavailable("admin", now);
  });

  it("orders same-second runs by run_id instead of accepting an older good run", async () => {
    const tiedAt = new Date(baselineStartedAt.getTime() + 2_000);
    const ids = [
      "00000000-0000-4000-8000-000000000101",
      "00000000-0000-4000-8000-000000000202",
    ];
    await insertRun({ id: ids[0], status: "published", startedAt: tiedAt, completedAt: tiedAt });
    await insertRun({ id: ids[1], status: "published", startedAt: tiedAt, completedAt: tiedAt });
    const latest = await pool!.request()
      .query<{ run_id: string }>(`SELECT TOP (1) run_id FROM portal.IngestionRun
        WHERE source_kind = 'directory' ORDER BY started_at DESC, run_id DESC`);
    await pool!.request().input("runId", sql.UniqueIdentifier, latest.recordset[0]!.run_id)
      .query("UPDATE portal.IngestionRun SET status = 'failed', error_code = 'profile_read_failed' WHERE run_id = @runId");
    await setSourceEvidence(tiedAt, directorySources, "profile_read_failed", baselineCompletedAt);

    await expectUnavailable();
  });

  it("fails closed when the current source login is ambiguous", async () => {
    await pool!.request()
      .input("userId", sql.BigInt, 990085099)
      .input("login", sql.NVarChar(255), "SYNTHETIC-admin")
      .query(`INSERT INTO portal.dim_user (user_id, login, state) VALUES (@userId, @login, 'active')`);
    await expectUnavailable();
  });

  it("denies the committed phase-one reservation before the writer starts phase two", async () => {
    let phaseOneReady!: () => void;
    let releasePhaseOne!: () => void;
    const phaseOne = new Promise<void>((resolve) => { phaseOneReady = resolve; });
    const holdPhaseOne = new Promise<void>((resolve) => { releasePhaseOne = resolve; });
    let transactions = 0;
    const writer = createDirectorySqlWriter(() => {
      const transaction = new sql.Transaction(pool!);
      if (++transactions === 1) {
        const commit = transaction.commit.bind(transaction);
        vi.spyOn(transaction, "commit").mockImplementation(async () => {
          await commit();
          phaseOneReady();
          await holdPhaseOne;
        });
      }
      return transaction;
    });

    const write = writer.commit(successfulDirectoryCommit(new Date(baselineStartedAt.getTime() + 2_000))).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let writeResult: Awaited<typeof write> | undefined;
    try {
      await waitBounded(phaseOne, "The directory writer did not finish its phase-one reservation.");
      await expectUnavailable();
    } finally {
      releasePhaseOne();
      writeResult = await write;
    }
    expect(writeResult).toEqual({ ok: true });
  });

  it.each([
    ["commit", true],
    ["rollback", false],
  ] as const)("blocks a reader on phase-two %s and observes no mixed snapshot", async (_mode, shouldCommit) => {
    let phaseTwoReady!: (sessionId: number) => void;
    let releasePhaseTwo!: () => void;
    const phaseTwo = new Promise<number>((resolve) => { phaseTwoReady = resolve; });
    const holdCommit = new Promise<void>((resolve) => { releasePhaseTwo = resolve; });
    let transactions = 0;
    const writer = createDirectorySqlWriter(() => {
      const transaction = new sql.Transaction(pool!);
      if (++transactions === 2) {
        const commit = transaction.commit.bind(transaction);
        vi.spyOn(transaction, "commit").mockImplementation(async () => {
          const result = await transaction.request().query<{ session_id: number }>("SELECT @@SPID AS session_id");
          phaseTwoReady(result.recordset[0]!.session_id);
          await holdCommit;
          if (!shouldCommit) throw new Error("synthetic phase-two rollback");
          await commit();
        });
      }
      return transaction;
    });

    const write = writer.commit(successfulDirectoryCommit(new Date(baselineStartedAt.getTime() + 2_000))).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      const writerSessionId = await waitBounded(
        phaseTwo,
        "The directory writer did not reach phase-two publication.",
      );
      const read = resolveForPersona("admin");
      await waitForLockWait(writerSessionId);
      releasePhaseTwo();
      const result = await write;
      expect(result.ok).toBe(shouldCommit);
      if (shouldCommit) {
        await expect(read).resolves.toEqual({
          state: "authorized",
          userId: userIds[0],
          login: "synthetic-admin-updated",
        });
      } else {
        await expect(read).resolves.toEqual({ state: "permissions_unavailable" });
      }
    } finally {
      releasePhaseTwo();
      await write;
    }
  });

  it("holds the global latest-run range while a phase-one reservation attempts to start", async () => {
    const originalCommit = sql.Transaction.prototype.commit;
    let pauseFirstCommit = true;
    let readerReady!: (sessionId: number) => void;
    let releaseReader!: () => void;
    const readerPaused = new Promise<number>((resolve) => { readerReady = resolve; });
    const holdReader = new Promise<void>((resolve) => { releaseReader = resolve; });
    const commitSpy = vi.spyOn(sql.Transaction.prototype, "commit").mockImplementation(async function (this: sql.Transaction) {
      if (pauseFirstCommit) {
        pauseFirstCommit = false;
        const result = await this.request().query<{ session_id: number }>("SELECT @@SPID AS session_id");
        readerReady(result.recordset[0]!.session_id);
        await holdReader;
      }
      await new Promise<void>((resolve, reject) => {
        originalCommit.call(this, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });

    const read = resolveForPersona("admin").then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let write: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    try {
      const readerSessionId = await waitBounded(
        readerPaused,
        "The Budget reader did not reach its authorization commit.",
      );
      const writer = createDirectorySqlWriter(() => new sql.Transaction(pool!));
      write = writer.commit(successfulDirectoryCommit(new Date(baselineStartedAt.getTime() + 2_000))).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForLockWait(readerSessionId);
      releaseReader();
      await expect(read).resolves.toEqual({
        ok: true,
        value: { state: "authorized", userId: userIds[0], login: "synthetic-admin" },
      });
      await expect(write).resolves.toEqual({ ok: true });
    } finally {
      releaseReader();
      commitSpy.mockRestore();
      if (write) await write;
    }
  });
});
