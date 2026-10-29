import { describe, expect, it } from "vitest";
import { DirectoryUserSchema } from "../../../shared/src/directory-input.js";
import { revocationCandidates } from "./revocation.js";
import type { DirectoryProfile } from "./providers.js";

function profile(userId: number, oid: string, state: "active" | "suspended" | "deleted"): DirectoryProfile {
  return {
    user: DirectoryUserSchema.parse({ user_id: userId, entra_object_id: oid, entra_account_enabled: state === "active", state }),
    managerResolved: true,
    errorCode: null,
  };
}

const oid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("revocationCandidates", () => {
  it("selects disabled and deleted Entra identities only", () => {
    const users = [profile(1, oid(1), "active"), profile(2, oid(2), "suspended"), profile(3, oid(3), "deleted")];
    expect(revocationCandidates(users, new Map())).toEqual([
      { entra_object_id: oid(2), reason: "entra_disabled", transitioned: false },
      { entra_object_id: oid(3), reason: "entra_deleted", transitioned: false },
    ]);
  });

  it("marks the run where an active user became disabled", () => {
    const users = [profile(2, oid(2), "suspended"), profile(3, oid(3), "suspended")];
    expect(revocationCandidates(users, new Map([[2, "active"], [3, "suspended"]])).map(({ transitioned }) => transitioned))
      .toEqual([true, false]);
  });
});
