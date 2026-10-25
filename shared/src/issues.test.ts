import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "./audit";
import {
  ISSUE_ACTIONS,
  ISSUE_STATUSES,
  deriveIssueStatus,
  evaluateDayReplacement,
  validateIssueActionRequest,
} from "./issues";
import { VALIDATION_ERROR_CODES } from "./rows";

describe("issue action sets (item 10)", () => {
  it("is fixed per type", () => {
    expect(ISSUE_ACTIONS).toEqual({
      duplicate_file: ["retry", "accept_last", "accept_first", "reject"],
      smaller_day: ["force", "discard"],
    });
    expect(ISSUE_STATUSES).toEqual(["open", "resolved", "dismissed"]);
  });
});

describe("validateIssueActionRequest", () => {
  const base = { issueId: 7, confirm: true };
  it("accepts an action from the type's set when an admin confirms", () => {
    expect(validateIssueActionRequest({ ...base, action: "accept_last" }, "duplicate_file", true)).toEqual({ ok: true });
    expect(validateIssueActionRequest({ ...base, action: "force" }, "smaller_day", true)).toEqual({ ok: true });
  });
  it("rejects an action that belongs to another type", () => {
    expect(validateIssueActionRequest({ ...base, action: "force" }, "duplicate_file", true)).toEqual({ ok: false, code: "invalid_action" });
    expect(validateIssueActionRequest({ ...base, action: "retry" }, "smaller_day", true)).toEqual({ ok: false, code: "invalid_action" });
  });
  it("denies non-admins before anything else", () => {
    expect(validateIssueActionRequest({ ...base, action: "bogus" }, "smaller_day", false)).toEqual({ ok: false, code: "forbidden" });
  });
  it("requires explicit confirmation", () => {
    expect(validateIssueActionRequest({ issueId: 7, action: "discard", confirm: false }, "smaller_day", true)).toEqual({
      ok: false,
      code: "confirmation_required",
    });
  });
});

describe("deriveIssueStatus", () => {
  it("is open without an action", () => {
    expect(deriveIssueStatus({ lastAction: null, handledAt: null })).toBe("open");
  });
  it("stays open while a chosen action waits for ingestion", () => {
    expect(deriveIssueStatus({ lastAction: "accept_first", handledAt: null })).toBe("open");
  });
  it("is resolved once ingestion handled a reprocessing action", () => {
    expect(deriveIssueStatus({ lastAction: "accept_first", handledAt: "2026-01-01T00:00:00Z" })).toBe("resolved");
  });
  it("is dismissed by reject or discard", () => {
    expect(deriveIssueStatus({ lastAction: "reject", handledAt: "2026-01-01T00:00:00Z" })).toBe("dismissed");
    expect(deriveIssueStatus({ lastAction: "discard", handledAt: "2026-01-01T00:00:00Z" })).toBe("dismissed");
  });
});

describe("evaluateDayReplacement (item 9)", () => {
  it("allows an equal or larger replacement", () => {
    expect(evaluateDayReplacement({ storedRows: 10, incomingRows: 10, adminForce: false, reportDay: "2026-01-05" })).toEqual({ decision: "allow" });
    expect(evaluateDayReplacement({ storedRows: 10, incomingRows: 11, adminForce: false, reportDay: "2026-01-05" })).toEqual({ decision: "allow" });
  });
  it("blocks and quarantines a smaller day by default", () => {
    expect(evaluateDayReplacement({ storedRows: 10, incomingRows: 9, adminForce: false, reportDay: "2026-01-05" })).toEqual({
      decision: "quarantine",
      issueCode: "smaller_day_blocked",
    });
  });
  it("lets a smaller day through only with the admin force flag, and records an audit row", () => {
    expect(evaluateDayReplacement({ storedRows: 10, incomingRows: 9, adminForce: true, reportDay: "2026-01-05" })).toEqual({
      decision: "allow",
      audit: "day.replace_forced",
      auditDetail: { reportDay: "2026-01-05", storedRows: 10, incomingRows: 9, emptyDayConfirmed: false },
    });
  });
  it("never forces when nothing is stored", () => {
    expect(evaluateDayReplacement({ storedRows: 0, incomingRows: 0, adminForce: true, reportDay: "2026-01-05" })).toEqual({ decision: "allow" });
  });
  it("requires the typed day confirmation to force an empty day", () => {
    const base = { storedRows: 10, incomingRows: 0, adminForce: true, reportDay: "2026-01-05" };
    expect(evaluateDayReplacement(base)).toEqual({
      decision: "quarantine",
      issueCode: "smaller_day_blocked",
      reason: "empty_day_confirmation_required",
    });
    expect(evaluateDayReplacement({ ...base, confirmDate: "2026-01-06" })).toMatchObject({ decision: "quarantine" });
    expect(evaluateDayReplacement({ ...base, confirmDate: "2026-01-05" })).toEqual({
      decision: "allow",
      audit: "day.replace_forced",
      auditDetail: { reportDay: "2026-01-05", storedRows: 10, incomingRows: 0, emptyDayConfirmed: true },
    });
  });
  it("records the day and counts in the audit detail of a forced smaller day", () => {
    expect(evaluateDayReplacement({ storedRows: 10, incomingRows: 9, adminForce: true, reportDay: "2026-01-05" })).toMatchObject({
      auditDetail: { reportDay: "2026-01-05", storedRows: 10, incomingRows: 9, emptyDayConfirmed: false },
    });
  });
  it("rejects a force action on an empty day without the typed date", () => {
    const ctx = { reportDay: "2026-01-05", incomingRows: 0 };
    const req = { issueId: 7, action: "force", confirm: true };
    expect(validateIssueActionRequest(req, "smaller_day", true, ctx)).toEqual({ ok: false, code: "empty_day_confirmation_required" });
    expect(validateIssueActionRequest({ ...req, confirmDate: "2026-01-05" }, "smaller_day", true, ctx)).toEqual({ ok: true });
    expect(validateIssueActionRequest({ ...req }, "smaller_day", true, { reportDay: "2026-01-05", incomingRows: 3 })).toEqual({ ok: true });
  });
  it("treats invalid counts as blocked", () => {
    expect(evaluateDayReplacement({ storedRows: 10, incomingRows: Number.NaN, adminForce: false, reportDay: "2026-01-05" })).toMatchObject({ decision: "quarantine" });
  });
});

describe("validation codes and audit actions", () => {
  it("lists the new fatal codes", () => {
    for (const c of ["duplicate_file", "duplicate_nested_name", "smaller_day_blocked"]) {
      expect(VALIDATION_ERROR_CODES.fatal).toContain(c);
    }
    expect(VALIDATION_ERROR_CODES.warn).toContain("attribute_empty_share");
  });
  it("lists the audit row types and their writer", () => {
    expect(AUDIT_ACTIONS["grant.created"]).toBe("portal");
    expect(AUDIT_ACTIONS["issue.action_applied"]).toBe("portal");
    expect(AUDIT_ACTIONS["day.replace_forced"]).toBe("portal");
    expect(AUDIT_ACTIONS["grant.revoked_by_directory_sync"]).toBe("ingestion");
    expect(AUDIT_ACTIONS["login_history.purged"]).toBe("ingestion");
  });
});
