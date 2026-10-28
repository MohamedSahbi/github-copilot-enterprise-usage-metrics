import { describe, expect, it } from "vitest";
import type { AccessResult } from "../authz/access";
import { canViewFeedbackItem, feedbackEnabled } from "./access";

const member: AccessResult = {
  state: "authorized", breakGlass: false, namesVisible: false,
  principal: {
    principal_id: "00000000-0000-4000-8000-000000000001",
    entra_tenant_id: "00000000-0000-4000-8000-000000000002",
    entra_object_id: "00000000-0000-4000-8000-000000000003",
    github_user_id: 1001, status: "active",
  },
  grants: [{ role: "user", scope: "self", scope_value: "" }],
};
const other = "00000000-0000-4000-8000-000000000004";

describe("Feedback access adapted from the original author-or-admin policy", () => {
  it("defaults the existing deployment flag off and rejects malformed configuration", () => {
    expect(feedbackEnabled({})).toBe(false);
    expect(feedbackEnabled({ MODULE_FEEDBACK: "false" })).toBe(false);
    expect(feedbackEnabled({ MODULE_FEEDBACK: "true" })).toBe(true);
    expect(() => feedbackEnabled({ MODULE_FEEDBACK: "yes" })).toThrow();
  });
  it("allows authorized members to see everyone items, not another author's private item", () => {
    expect(canViewFeedbackItem(member, { visibility: "everyone", author_principal_id: other })).toBe(true);
    expect(canViewFeedbackItem(member, { visibility: "admins", author_principal_id: other })).toBe(false);
  });
  it("uses the immutable principal ID for the author's private item", () => {
    expect(canViewFeedbackItem(member, {
      visibility: "admins", author_principal_id: member.principal.principal_id.toUpperCase(),
    })).toBe(true);
  });
  it("allows an effective admin grant, not a manager grant, to see private items", () => {
    expect(canViewFeedbackItem({ ...member, grants: [{ role: "admin", scope: "company", scope_value: "" }] },
      { visibility: "admins", author_principal_id: other })).toBe(true);
    expect(canViewFeedbackItem({ ...member, grants: [{ role: "manager", scope: "team", scope_value: "" }] },
      { visibility: "admins", author_principal_id: other })).toBe(false);
  });
  it.each(["signed-out", "no-access", "unavailable"] as const)("denies %s, including break-glass-only access", (state) => {
    const access: AccessResult = state === "signed-out"
      ? { state, breakGlass: false } : { state, breakGlass: true };
    expect(canViewFeedbackItem(access, { visibility: "everyone", author_principal_id: other })).toBe(false);
  });
  it("fails closed for an unknown visibility value", () => {
    expect(canViewFeedbackItem(member, { visibility: "unknown", author_principal_id: other })).toBe(false);
  });
});
