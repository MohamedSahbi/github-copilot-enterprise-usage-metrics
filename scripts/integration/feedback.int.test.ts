import sql from "mssql";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AccessResult } from "../../portal/src/authz/access";
import { getFeedback, listFeedback, toggleFeedbackVote } from "../../portal/src/feedback/sql-feedback";
import { AUTH_OBJECTS_BY_PERSONA, AUTH_PRINCIPALS_BY_PERSONA, AUTH_TENANT, seedAuth } from "./auth-seed";
import { cleanupFeedback, seedFeedback, type FeedbackSeedIds } from "./feedback-seed";
import { openPool } from "./db";

type Access = Extract<AccessResult, { state: "authorized" }>;
function accessFor(persona: "admin" | "member" | "manager"): Access {
  return {
    state: "authorized", breakGlass: false, namesVisible: false,
    principal: {
      principal_id: AUTH_PRINCIPALS_BY_PERSONA[persona], entra_tenant_id: AUTH_TENANT,
      entra_object_id: AUTH_OBJECTS_BY_PERSONA[persona], github_user_id: null, status: "active",
    },
    grants: persona === "admin" ? [{ role: "admin", scope: "company", scope_value: "" }]
      : persona === "manager" ? [{ role: "manager", scope: "team", scope_value: "" }]
        : [{ role: "user", scope: "self", scope_value: "" }],
  };
}
let pool: sql.ConnectionPool;
let ids: FeedbackSeedIds = [0, 0, 0];

describe("Feedback SQL visibility and vote toggle", () => {
  beforeAll(async () => { pool = await openPool(); await seedAuth(pool); });
  beforeEach(async () => { ids = await seedFeedback(pool); });
  afterEach(async () => { await cleanupFeedback(pool, ids); ids = [0, 0, 0]; });
  afterAll(async () => { await pool.close(); });

  it("filters both page and total to public-or-author-or-admin items", async () => {
    const result = await listFeedback(pool, accessFor("member"), { page: 1, pageSize: 25 });
    expect(result.totalItems).toBe(2);
    expect(result.rows.map(({ itemId }) => itemId).sort((a, b) => a - b)).toEqual([ids[0], ids[2]]);
    expect(result.rows.every(({ authorDisplayName }) => authorDisplayName === null)).toBe(true);
    expect((await listFeedback(pool, accessFor("admin"), { page: 1, pageSize: 25 })).totalItems).toBe(3);
    expect((await listFeedback(pool, accessFor("manager"), { page: 1, pageSize: 25 })).totalItems).toBe(1);
  });
  it("applies status filters and stable paging", async () => {
    await pool.request().input("id", sql.BigInt, ids[0])
      .query("UPDATE portal.FeedbackItem SET status = 'planned' WHERE item_id = @id");
    const result = await listFeedback(pool, accessFor("member"), { page: 1, pageSize: 1, status: "planned" });
    expect(result.totalItems).toBe(1);
    expect(result.rows.map(({ itemId }) => itemId)).toEqual([ids[0]]);
    expect((await listFeedback(pool, accessFor("member"), { page: 2, pageSize: 1, status: "planned" })).rows).toEqual([]);
  });
  it("checks parent visibility for a direct item read", async () => {
    expect(await getFeedback(pool, accessFor("member"), ids[1])).toBeNull();
    expect((await getFeedback(pool, accessFor("member"), ids[2]))?.itemId).toBe(ids[2]);
    expect((await getFeedback(pool, accessFor("admin"), ids[2]))?.itemId).toBe(ids[2]);
  });
  it("denies voting on another author's private parent without writing a vote", async () => {
    expect(await toggleFeedbackVote(pool, accessFor("member"), ids[1])).toBeNull();
    expect((await getFeedback(pool, accessFor("admin"), ids[1]))?.votes).toBe(0);
  });
  it("toggles the same caller's vote without removing another caller's vote", async () => {
    expect((await toggleFeedbackVote(pool, accessFor("member"), ids[0]))?.votes).toBe(1);
    expect((await toggleFeedbackVote(pool, accessFor("admin"), ids[0]))?.votes).toBe(2);
    expect((await toggleFeedbackVote(pool, accessFor("member"), ids[0]))?.votes).toBe(1);
  });
  it("serializes concurrent toggles for one item", async () => {
    await Promise.all([
      toggleFeedbackVote(pool, accessFor("member"), ids[0]),
      toggleFeedbackVote(pool, accessFor("member"), ids[0]),
    ]);
    expect((await getFeedback(pool, accessFor("member"), ids[0]))?.votes).toBe(0);
  });
});
