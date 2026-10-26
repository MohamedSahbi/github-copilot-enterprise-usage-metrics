import { describe, expect, it, vi } from "vitest";
import { collectDirectoryIdentities, readGraphProfile, DirectoryProviderError, type DirectoryTransport } from "./providers.js";

const oid = "00000000-0000-0000-0000-000000000001";
const managerId = "00000000-0000-0000-0000-000000000002";
const profile = { externalId: oid, active: true, profileUrl: "https://github.com/fixture-user" };
const seat = { assignee: { id: 42, login: "FIXTURE-USER" } };
const transport = (bodies: unknown[]): DirectoryTransport => vi.fn().mockImplementation(async () => {
  const body = bodies.shift();
  if (body === undefined) throw new Error("unexpected request");
  return { status: 200, body };
});

describe("configured SCIM/seats population", () => {
  it("joins profileUrl case-insensitively to a numeric seat identity, ignoring userName", async () => {
    const get = transport([
      { totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [{ ...profile, userName: "not-a-login@example.invalid" }] },
      { total_seats: 1, seats: [seat] },
    ]);
    expect(await collectDirectoryIdentities(get, "fixture-enterprise", ["fixture-org"])).toEqual({
      identities: [{ userId: 42, login: "FIXTURE-USER", entraObjectId: oid, active: true }],
      licensedSeats: 1, unmappedLicensedProfiles: 0, scimWithoutSeats: 0,
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("pages both sources completely and distinguishes no-seat SCIM profiles", async () => {
    const get = transport([
      { totalResults: 2, startIndex: 1, itemsPerPage: 1, Resources: [profile] },
      { totalResults: 2, startIndex: 2, itemsPerPage: 1, Resources: [{ ...profile, externalId: managerId, profileUrl: "https://github.com/no-seat" }] },
      { total_seats: 2, seats: [seat] },
      { total_seats: 2, seats: [{ assignee: { id: 43, login: "unmapped-seat" } }] },
    ]);
    expect(await collectDirectoryIdentities(get, "fixture-enterprise", ["fixture-org"])).toMatchObject({
      licensedSeats: 2, unmappedLicensedProfiles: 1, scimWithoutSeats: 1,
    });
    expect(get).toHaveBeenCalledTimes(4);
  });

  it.each([undefined, "", "https://example.invalid/fixture-user", "https://github.com/fixture-user/repositories", "https://github.com/fixture-user?x=1"])(
    "never guesses userName when profileUrl is invalid (%s)", async (profileUrl) => {
      const get = transport([
        { totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [{ ...profile, profileUrl, userName: "fixture-user" }] },
        { total_seats: 1, seats: [seat] },
      ]);
      expect(await collectDirectoryIdentities(get, "fixture-enterprise", ["fixture-org"])).toMatchObject({
        identities: [], unmappedLicensedProfiles: 1,
      });
    },
  );

  it("accepts hash-shaped logins without attempting username normalization", async () => {
    const login = "a".repeat(24) + "_fixture";
    const get = transport([
      { totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [{ ...profile, profileUrl: `https://github.com/${login}` }] },
      { total_seats: 1, seats: [{ assignee: { id: 42, login } }] },
    ]);
    expect((await collectDirectoryIdentities(get, "fixture-enterprise", ["fixture-org"])).identities[0]?.userId).toBe(42);
  });

  it("rejects ambiguous Entra identity mapping instead of linking two accounts", async () => {
    const get = transport([
      { totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [profile, { ...profile, profileUrl: "https://github.com/other-user" }] },
      { total_seats: 2, seats: [seat, { assignee: { id: 43, login: "other-user" } }] },
    ]);
    expect(await collectDirectoryIdentities(get, "fixture-enterprise", ["fixture-org"])).toMatchObject({
      identities: [], unmappedLicensedProfiles: 2,
    });
  });

  it("deduplicates the same stable seat across configured organizations", async () => {
    const get = transport([
      { totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [profile] },
      { total_seats: 1, seats: [seat] }, { total_seats: 1, seats: [seat] },
    ]);
    expect(await collectDirectoryIdentities(get, "fixture-enterprise", ["first-org", "second-org"])).toMatchObject({ licensedSeats: 1, unmappedLicensedProfiles: 0 });
  });

  it.each([
    { totalResults: 2, startIndex: 1, itemsPerPage: 1, Resources: [] },
    { totalResults: 1, startIndex: 2, itemsPerPage: 1, Resources: [profile] },
    { totalResults: -1, startIndex: 1, itemsPerPage: 0, Resources: [] },
    { Resources: [profile] },
  ])("rejects incomplete/malformed SCIM pagination without source payload in the error", async (body) => {
    await expect(collectDirectoryIdentities(transport([body]), "fixture-enterprise", ["fixture-org"]))
      .rejects.toMatchObject({ name: "DirectoryProviderError", code: "invalid_scim_page" });
  });

  it.each([
    { total_seats: 1, seats: [] },
    { total_seats: 2, seats: [seat, seat] },
    { total_seats: 2, seats: [seat, { assignee: { id: 43, login: "fixture-user" } }] },
    { total_seats: 1, seats: [{ assignee: { id: "42", login: "fixture-user" } }] },
    { seats: [seat] },
  ])("rejects partial or ambiguous seats without publishing an empty population", async (body) => {
    const get = transport([
      { totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [profile] }, body,
    ]);
    await expect(collectDirectoryIdentities(get, "fixture-enterprise", ["fixture-org"]))
      .rejects.toMatchObject({ code: "invalid_seats_page" });
  });

  it("treats duplicate profileUrl matches as unresolved, even with distinct Entra IDs", async () => {
    const get = transport([
      { totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [profile, { ...profile, externalId: managerId }] },
      { total_seats: 1, seats: [seat] },
    ]);
    expect(await collectDirectoryIdentities(get, "fixture-enterprise", ["fixture-org"]))
      .toMatchObject({ identities: [], unmappedLicensedProfiles: 1 });
  });

  it("accepts explicitly complete empty populations", async () => {
    const get = transport([
      { totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] }, { total_seats: 0, seats: [] },
    ]);
    expect(await collectDirectoryIdentities(get, "fixture-enterprise", ["fixture-org"]))
      .toEqual({ identities: [], licensedSeats: 0, unmappedLicensedProfiles: 0, scimWithoutSeats: 0 });
  });
});

describe("per-profile Graph reads", () => {
  const identity = { userId: 42, login: "fixture-user", entraObjectId: oid, active: true };
  const attrs = { departmentAttribute: "department", businessAreaAttribute: "onPremisesExtensionAttributes.extensionAttribute1" };
  const graphProfile = { id: oid, accountEnabled: true, mail: "fixture@example.invalid", displayName: "Fixture",
    department: " Engineering ", onPremisesExtensionAttributes: { extensionAttribute1: " Example Area " } };

  it("reads profile and current manager by immutable ID on every invocation", async () => {
    const get = transport([graphProfile, { id: managerId, mail: "manager@example.invalid" }, graphProfile, { id: managerId, userPrincipalName: "manager@example.invalid" }]);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await readGraphProfile(get, identity, attrs)).toMatchObject({
        user: { user_id: 42, entra_object_id: oid, manager_entra_object_id: managerId, manager_email: "manager@example.invalid", department: "engineering", business_area: "example area" },
        managerResolved: true, errorCode: null,
      });
    }
    expect(get).toHaveBeenCalledTimes(4);
    expect(get).toHaveBeenNthCalledWith(2, expect.stringContaining(`/users/${oid}/manager`));
  });

  it("only clears a relationship on explicitly authoritative no-manager classification", async () => {
    const get: DirectoryTransport = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: graphProfile })
      .mockResolvedValueOnce({ status: 404, body: null, authoritativeNoManager: true });
    expect(await readGraphProfile(get, identity, attrs)).toMatchObject({
      user: { manager_entra_object_id: null, manager_email: null }, managerResolved: true, errorCode: null,
    });
  });

  it.each([403, 404, 429, 500])("preserves cached manager on HTTP %s, including ambiguous 404", async (status) => {
    const get: DirectoryTransport = vi.fn().mockResolvedValueOnce({ status: 200, body: graphProfile })
      .mockResolvedValueOnce({ status, body: { error: { message: "private-marker@example.invalid" } } });
    expect(await readGraphProfile(get, identity, attrs)).toMatchObject({ managerResolved: false, errorCode: "manager_read_failed" });
  });

  it.each([{ id: managerId }, { id: "bad", mail: "manager@example.invalid" }, { id: managerId, mail: "" }, null])(
    "preserves cached manager on malformed or email-less response", async (manager) => {
      expect(await readGraphProfile(transport([graphProfile, manager]), identity, attrs))
        .toMatchObject({ managerResolved: false, errorCode: "manager_read_failed" });
    },
  );

  it("sanitizes rejected network errors and does not treat them as no-manager", async () => {
    const get: DirectoryTransport = vi.fn().mockResolvedValueOnce({ status: 200, body: graphProfile })
      .mockRejectedValueOnce(new Error("private-marker@example.invalid"));
    const result = await readGraphProfile(get, identity, attrs);
    expect(result.managerResolved).toBe(false);
    expect(JSON.stringify({ errorCode: result.errorCode })).not.toContain("private-marker");
  });

  it("fails closed if Graph returns another immutable identity", async () => {
    await expect(readGraphProfile(transport([{ ...graphProfile, id: managerId }]), identity, attrs)).rejects.toBeInstanceOf(DirectoryProviderError);
  });

  it("cannot interpret missing profile context as authoritative manager absence", async () => {
    const get: DirectoryTransport = vi.fn().mockResolvedValue({ status: 404, body: null, authoritativeNoManager: true });
    await expect(readGraphProfile(get, identity, attrs)).rejects.toMatchObject({ code: "profile_read_failed" });
    expect(get).toHaveBeenCalledTimes(1);
  });
});
