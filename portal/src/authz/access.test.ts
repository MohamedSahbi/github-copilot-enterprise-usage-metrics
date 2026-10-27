import { describe, expect, it, vi } from "vitest";
import { resolveAccess, canAccess, type AccessRepository, type Identity } from "./access";
import { readAccessSettings } from "../auth/settings";

const identity: Identity = {
  provider: "entra",
  tenantId: "00000000-0000-4000-8000-000000000001",
  objectId: "00000000-0000-4000-8000-000000000002",
  groups: [], groupsVerifiedAt: new Date("2026-10-25T12:00:00Z").getTime(),
};
const now = new Date("2026-10-25T12:00:00Z");
const settings = readAccessSettings({});
const repo = (roles: ("admin" | "manager" | "user")[] = ["user"]): AccessRepository => ({
  read: vi.fn().mockResolvedValue({
    principal: { principal_id: "00000000-0000-4000-8000-000000000003", entra_tenant_id: identity.tenantId,
      entra_object_id: identity.objectId, github_user_id: 1001, status: "active" },
    grants: roles.map((role) => ({ role, scope: role === "admin" ? "company" : role === "manager" ? "team" : "self", scope_value: "" })),
    teamAvailable: true,
    sync: ["scim", "graph", "seats"].map((source) => ({ source, last_success_at: now })),
  }),
});

describe("fail-closed access resolution", () => {
  it("does not read SQL when signed out", async () => {
    const repository = repo();
    expect((await resolveAccess(null, repository, settings, now)).state).toBe("signed-out");
    expect(repository.read).not.toHaveBeenCalled();
  });
  it("returns no access for an unknown or unlinked identity", async () => {
    const repository: AccessRepository = { read: async () => ({ principal: null, grants: [], sync: [] }) };
    expect((await resolveAccess(identity, repository, settings, now)).state).toBe("no-access");
    expect((await resolveAccess({ provider: "github", userId: 1001 }, repository, settings, now)).state).toBe("no-access");
  });
  it("distinguishes SQL outage from no permissions and never grants data access", async () => {
    const result = await resolveAccess(identity, { read: async () => { throw new Error("SQL offline"); } }, settings, now);
    expect(result.state).toBe("unavailable");
    expect(canAccess(result, "data")).toBe(false);
  });
  it("denies elevated grants for missing, future, or stale directory sync but retains user scope", async () => {
    for (const sync of [[], [{ source: "scim", last_success_at: new Date(now.getTime() + 500 + 1) }],
      ["scim", "graph", "seats"].map((source) => ({ source, last_success_at: new Date(now.getTime() - 36 * 3600000 - 1) }))]) {
      const base = await repo(["admin", "user"]).read(identity);
      const result = await resolveAccess(identity, { read: async () => ({ ...base, sync }) }, settings, now);
      expect(result.state).toBe("authorized");
      if (result.state === "authorized") expect(result.grants.map((g) => g.role)).toEqual(["user"]);
      expect(canAccess(result, "admin")).toBe(false);
    }
  });
  it("tolerates up to 500 ms of future (DATETIME2(0) rounding) sync timestamps and keeps the stale boundary", async () => {
    const hour = 3600000;
    const cases: [number, boolean][] = [
      [1, true], [500, true], [500 + 1, false],
      [-36 * hour, true], [-36 * hour - 1, false],
    ];
    for (const [offset, fresh] of cases) {
      const base = await repo(["admin"]).read(identity);
      const sync = ["scim", "graph", "seats"].map((source) => ({ source, last_success_at: new Date(now.getTime() + offset) }));
      const result = await resolveAccess(identity, { read: async () => ({ ...base, sync }) }, settings, now);
      expect(result.state === "authorized", `offset ${offset}`).toBe(fresh);
    }
  });
  it("allows fresh elevated grants, and resolves namesVisible from deployment settings only", async () => {
    const result = await resolveAccess(identity, repo(["admin"]), settings, now);
    expect(canAccess(result, "admin")).toBe(true);
    if (result.state === "authorized") expect(result.namesVisible).toBe(false);
    const detail = await resolveAccess(identity, repo(), { ...settings, perUserDetailEnabled: true }, now);
    if (detail.state === "authorized") expect(detail.namesVisible).toBe(true);
  });
  it.each([false, undefined])("denies team grants when resolved report availability is %s without changing self access", async (teamAvailable) => {
    const base = await repo(["manager", "user"]).read(identity);
    const result = await resolveAccess(identity, { read: async () => ({ ...base, teamAvailable }) }, settings, now);
    expect(result.state).toBe("authorized");
    if (result.state === "authorized") expect(result.grants.map(({ scope }) => scope)).toEqual(["self"]);
  });
  it("retains team grants with fresh reports despite unrelated source-level failure or staleness", async () => {
    const base = await repo(["manager"]).read(identity);
    expect((await resolveAccess(identity, { read: async () => ({ ...base, sync: [] }) }, settings, now)).state).toBe("authorized");
  });
  it("break-glass reaches only admin and health during an outage", async () => {
    const group = "00000000-0000-4000-8000-000000000004";
    const result = await resolveAccess({ ...identity, groups: [group] }, {
      read: async () => { throw new Error("offline"); },
    }, { ...settings, breakGlassGroupId: group }, now);
    expect(canAccess(result, "admin")).toBe(true);
    expect(canAccess(result, "health")).toBe(true);
    expect(canAccess(result, "data")).toBe(false);
    expect(canAccess(result, "feedback")).toBe(false);
  });
  it("a GitHub identity can never exercise Entra break-glass", async () => {
    const result = await resolveAccess({ provider: "github", userId: 1001 }, {
      read: async () => { throw new Error("offline"); },
    }, settings, now);
    expect(canAccess(result, "admin")).toBe(false);
  });
  it("expires break-glass evidence at the configured freshness boundary", async () => {
    const group = "00000000-0000-4000-8000-000000000004";
    for (const groupsVerifiedAt of [undefined, now.getTime() + 1, now.getTime() - 5 * 60000]) {
      const result = await resolveAccess({ ...identity, groups: [group], groupsVerifiedAt }, {
        read: async () => { throw new Error("offline"); },
      }, { ...settings, breakGlassGroupId: group }, now);
      expect(canAccess(result, "admin")).toBe(false);
    }
  });
  it("reads permissions on every request, including immediately after revocation", async () => {
    const repository = repo();
    expect((await resolveAccess(identity, repository, settings, now)).state).toBe("authorized");
    vi.mocked(repository.read).mockResolvedValueOnce({ principal: null, grants: [], sync: [] });
    expect((await resolveAccess(identity, repository, settings, now)).state).toBe("no-access");
    expect(repository.read).toHaveBeenCalledTimes(2);
  });
});

describe("access settings", () => {
  it("uses default freshness 5 and accepts boundaries 1 and 60", () => {
    expect(settings.permissionFreshnessMinutes).toBe(5);
    for (const value of ["1", "60"]) {
      expect(readAccessSettings({ ACCESS_PERMISSION_FRESHNESS_MINUTES: value }).permissionFreshnessMinutes).toBe(Number(value));
    }
  });
  it("rejects invalid freshness instead of silently falling back", () => {
    for (const value of ["0", "61", "NaN", "1.5", ""]) {
      expect(() => readAccessSettings({ ACCESS_PERMISSION_FRESHNESS_MINUTES: value })).toThrow();
    }
  });
  it("rejects unsafe request links and malformed break-glass IDs", () => {
    expect(() => readAccessSettings({ ACCESS_REQUEST_URL: "javascript:alert(1)" })).toThrow();
    expect(() => readAccessSettings({ ACCESS_BREAK_GLASS_GROUP_ID: "admin" })).toThrow();
  });
});
