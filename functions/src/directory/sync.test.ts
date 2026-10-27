import { describe, expect, it, vi } from "vitest";
import { syncDirectory, type DirectoryCommit, type DirectorySyncDependencies } from "./sync.js";
import type { DirectoryTransport } from "./providers.js";

const oid = "00000000-0000-0000-0000-000000000001";
const managerOid = "00000000-0000-0000-0000-000000000002";
const now = "2026-10-26T12:00:00.000Z";
const runId = "00000000-0000-0000-0000-000000000003";
const input = { provider: "entra" as const, enterprise: "fixture-enterprise", organizations: ["fixture-org"],
  attributes: { departmentAttribute: "department", businessAreaAttribute: "" }, runId, correlationId: runId };

function setup(options: { unmapped?: boolean; managerStatus?: number; collectionFailure?: boolean } = {}) {
  const commits: DirectoryCommit[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const get: DirectoryTransport = vi.fn(async (path) => {
    if (options.collectionFailure) throw new Error("private-profile@example.invalid");
    if (path.startsWith("/scim/")) return { status: 200, body: {
      totalResults: 1, startIndex: 1, itemsPerPage: 1,
      Resources: [{ externalId: oid, active: true, profileUrl: "https://github.com/fixture-user" }],
    } };
    if (path.includes("/seats?")) return { status: 200, body: {
      total_seats: options.unmapped ? 2 : 1, seats: [
        { assignee: { id: 42, login: "fixture-user" } },
        ...(options.unmapped ? [{ assignee: { id: 43, login: "private-unmapped-login" } }] : []),
      ],
    } };
    if (path.includes("/manager?")) return { status: options.managerStatus ?? 200, body: { id: managerOid, mail: "manager@example.invalid" } };
    return { status: 200, body: { id: oid, accountEnabled: true, mail: "profile@example.invalid", department: "Engineering" } };
  });
  const dependencies: DirectorySyncDependencies = {
    github: get, graph: get, now: () => new Date(now), logger,
    writer: { commit: async (command) => { commits.push(command); } },
  };
  return { dependencies, commits, logger, get };
}

describe("directory synchronization boundary", () => {
  it("persists current manager adjacency and source success only on complete synchronization", async () => {
    const { dependencies, commits } = setup();
    expect(await syncDirectory(input, dependencies)).toEqual({ runId, status: "published", rowsLoaded: 1, unmappedLicensedProfiles: 0 });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      run: { source_kind: "directory", rows_read: 1, rows_loaded: 1, rows_quarantined: 0, status: "published", is_current: false },
      users: [{ user: { user_id: 42, manager_entra_object_id: managerOid, manager_email: "manager@example.invalid" }, managerResolved: true }],
      sync: ["scim", "seats", "graph"].map((source) => ({ source, last_success_at: now, last_attempt_at: now, last_error_code: null })),
    });
  });

  it("warns only aggregate unmapped licensed count; no unlink/revocation or successful freshness", async () => {
    const { dependencies, commits, logger } = setup({ unmapped: true });
    expect(await syncDirectory(input, dependencies)).toMatchObject({ status: "failed", unmappedLicensedProfiles: 1 });
    expect(commits[0]?.run).toMatchObject({ rows_read: 2, rows_loaded: 1, rows_quarantined: 1, error_code: "unmapped_licensed_profiles" });
    expect(commits[0]?.sync.every((source) => source.last_success_at === null)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith({
      event: "directory.unmapped_licensed_profiles", code: "unmapped_licensed_profiles", correlation_id: runId, unmapped_licensed_count: 1,
    });
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    for (const value of ["fixture-user", "private-unmapped-login", "profile@example.invalid", oid, managerOid]) expect(logged).not.toContain(value);
    expect(Object.keys(commits[0]!)).toEqual(["run", "users", "sync", "managerCheckUserIds"]);
  });

  it("writes a preserve-manager command on failures without replacing cache with NULL", async () => {
    const { dependencies, commits } = setup({ managerStatus: 403 });
    expect(await syncDirectory(input, dependencies)).toMatchObject({ status: "failed", rowsLoaded: 1 });
    expect(commits[0]?.users[0]?.managerResolved).toBe(false);
    expect(commits[0]?.run.error_code).toBe("manager_read_failed");
    expect(commits[0]?.sync.every((source) => source.last_success_at === null)).toBe(true);
  });

  it("tracks every licensed user for manager-resolution invalidation, including unmapped profiles", async () => {
    const { dependencies, commits } = setup({ unmapped: true });
    await syncDirectory(input, dependencies);
    expect(commits[0]).toMatchObject({ managerCheckUserIds: [42, 43] });
  });

  it("tracks failed profile reads without fabricating a directory profile", async () => {
    const { dependencies, commits } = setup();
    dependencies.graph = async () => ({ status: 403, body: null });
    await syncDirectory(input, dependencies);
    expect(commits[0]).toMatchObject({ users: [], managerCheckUserIds: [42] });
  });

  it("keeps a successful user's manager resolution independent of another user's failed read", async () => {
    const { dependencies, commits } = setup();
    const otherOid = "00000000-0000-0000-0000-000000000004";
    dependencies.github = async (path) => path.startsWith("/scim/") ? { status: 200, body: {
      totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [
        { externalId: oid, active: true, profileUrl: "https://github.com/fixture-user" },
        { externalId: otherOid, active: true, profileUrl: "https://github.com/other-user" },
      ],
    } } : { status: 200, body: { total_seats: 2, seats: [
      { assignee: { id: 42, login: "fixture-user" } },
      { assignee: { id: 43, login: "other-user" } },
    ] } };
    dependencies.graph = async (path) => {
      if (path.includes("/manager?")) return path.includes(otherOid)
        ? { status: 403, body: null }
        : { status: 200, body: { id: managerOid, mail: "manager@example.invalid" } };
      return { status: 200, body: { id: path.includes(otherOid) ? otherOid : oid, accountEnabled: true } };
    };
    await syncDirectory(input, dependencies);
    expect(commits[0]).toMatchObject({
      managerCheckUserIds: [42, 43],
      run: { status: "failed" },
      users: [
        { user: { user_id: 42 }, managerResolved: true, errorCode: null },
        { user: { user_id: 43 }, managerResolved: false, errorCode: "manager_read_failed" },
      ],
    });
  });

  it("records source failures explicitly, without successful empty data or raw exceptions", async () => {
    const { dependencies, commits, logger } = setup({ collectionFailure: true });
    expect(await syncDirectory(input, dependencies)).toMatchObject({ status: "failed", rowsLoaded: 0 });
    expect(commits[0]).toMatchObject({ users: [], run: { rows_read: null, rows_quarantined: null, error_code: "source_read_failed" } });
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls])).not.toContain("private-profile");
  });

  it("reuses strict CSV parsing and publishes nothing for an invalid whole file", async () => {
    const { dependencies, commits, get } = setup();
    const content = new TextEncoder().encode(`user_id,entra_object_id,state,entra_account_enabled\n42,${oid},active,true\nbad,${managerOid},active,true`);
    expect(await syncDirectory({ ...input, provider: "csv", content }, dependencies)).toMatchObject({ status: "failed", rowsLoaded: 0 });
    expect(commits[0]).toMatchObject({ users: [], run: { error_code: "invalid_row" }, sync: [{ source: "csv", last_success_at: null }] });
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects manager ID without required recognition email even in a structurally valid CSV", async () => {
    const { dependencies, commits } = setup();
    const content = new TextEncoder().encode(`user_id,entra_object_id,state,entra_account_enabled,manager_entra_object_id\n42,${oid},active,true,${managerOid}`);
    expect(await syncDirectory({ ...input, provider: "csv", content }, dependencies)).toMatchObject({ status: "failed" });
    expect(commits[0]?.users).toEqual([]);
  });

  it("does not catch SQL failures and pretend the run was persisted", async () => {
    const { dependencies } = setup();
    dependencies.writer.commit = async () => { throw new Error("SQL_WRITE_FAILED"); };
    await expect(syncDirectory(input, dependencies)).rejects.toThrow("SQL_WRITE_FAILED");
  });

  it.each(["scim", "seats", "graph"])("never advances any source success on partial %s collection", async (source) => {
    const { dependencies, commits } = setup();
    if (source === "graph") {
      dependencies.graph = async () => ({ status: 403, body: { message: "private-profile@example.invalid" } });
    } else {
      const original = dependencies.github;
      dependencies.github = async (path) => path.includes(source === "scim" ? "/scim/" : "/seats?")
        ? { status: 200, body: { incomplete: "private-profile@example.invalid" } }
        : original(path);
    }
    expect(await syncDirectory(input, dependencies)).toMatchObject({ status: "failed", rowsLoaded: 0 });
    expect(commits[0]?.sync.every((state) => state.last_success_at === null && state.last_error_code !== null)).toBe(true);
    expect(commits[0]?.users).toEqual([]);
    expect(commits[0]?.run.is_current).toBe(false);
  });

  it("keeps no-seat SCIM profiles out of the licensed warning and run quarantine count", async () => {
    const { dependencies, commits, logger } = setup();
    const original = dependencies.github;
    dependencies.github = async (path) => path.startsWith("/scim/") ? { status: 200, body: {
      totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [
        { externalId: oid, active: true, profileUrl: "https://github.com/fixture-user" },
        { externalId: managerOid, active: true, profileUrl: "https://github.com/no-seat" },
      ],
    } } : original(path);
    expect(await syncDirectory(input, dependencies)).toMatchObject({ status: "published", unmappedLicensedProfiles: 0 });
    expect(commits[0]?.run).toMatchObject({ rows_read: 1, rows_loaded: 1, rows_quarantined: 0 });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
