import { describe, expect, it } from "vitest";
import { identityFromProfile } from "./identity";

const tenant = "00000000-0000-4000-8000-000000000001";
const oid = "00000000-0000-4000-8000-000000000002";
describe("immutable provider identity", () => {
  it("requires matching tenant and object ID, never email or subject", () => {
    expect(identityFromProfile("microsoft-entra-id", { tid: tenant, oid }, tenant)?.provider).toBe("entra");
    for (const profile of [{ tid: oid, oid }, { tid: tenant, sub: oid }, { email: oid }, { tid: tenant, oid: "bad" }]) {
      expect(identityFromProfile("microsoft-entra-id", profile, tenant)).toBeNull();
    }
  });
  it("uses only numeric GitHub ID, not login, email, or caller permissions", () => {
    expect(identityFromProfile("github", { id: 1001, login: "admin", permissions: ["admin"] }, tenant))
      .toEqual({ provider: "github", userId: 1001 });
    for (const id of ["1001", 0, -1, 1.1, Infinity]) {
      expect(identityFromProfile("github", { id, email: oid }, tenant)).toBeNull();
    }
  });
});
