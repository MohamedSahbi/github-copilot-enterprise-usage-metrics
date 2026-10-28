import { describe, expect, it } from "vitest";
import { parseGrantInput, parseIssueInput } from "./input";

describe("admin mutation input", () => {
  const oid = "00000000-0000-4000-8000-000000000090";
  it("accepts the immutable target and legacy principal path, never email", () => {
    expect(parseGrantInput({ principalEntraObjectId: oid, role: "user", scope: "self" }, "create"))
      .toEqual({ principalEntraObjectId: oid, role: "user", scope: "self" });
    expect(parseGrantInput({ principalId: oid, role: "admin", scope: "company", action: "revoke" }, "legacy"))
      .toMatchObject({ principalId: oid, action: "revoke" });
    expect(() => parseGrantInput({ email: "person@example.invalid", role: "admin", scope: "company" }, "create")).toThrow();
  });
  it("rejects malformed, oversized and caller-asserted facts", () => {
    for (const body of [null, [], { principalEntraObjectId: oid, role: 1, scope: "self" },
      { principalEntraObjectId: oid, role: "user", scope: "self", principalHasLinkedEntraId: true },
      { principalEntraObjectId: oid, role: "user", scope: "self", scopeValue: "a".repeat(129) }]) {
      expect(() => parseGrantInput(body, "create")).toThrow();
    }
  });
  it("keeps role/scope semantic failures for the shared validator", () => {
    expect(parseGrantInput({ principalEntraObjectId: oid, role: "manager", scope: "company" }, "create"))
      .toMatchObject({ role: "manager", scope: "company" });
  });
  it("requires a safe inbox ID, exact boolean and bounded action", () => {
    expect(parseIssueInput({ issueId: 1, action: "force", confirm: true, confirmDate: "2026-01-01" }))
      .toMatchObject({ confirm: true });
    for (const body of [{ issueId: 0, action: "force", confirm: true },
      { issueId: 1, action: "force", confirm: "true" }, { issueId: 1, action: "unknown", confirm: true }]) {
      expect(() => parseIssueInput(body)).toThrow();
    }
  });
});
