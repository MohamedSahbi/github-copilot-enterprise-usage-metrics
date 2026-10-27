import { beforeEach, describe, expect, it, vi } from "vitest";
import UserDetailsPage from "./page";

const { getAccess, notFound, redirect } = vi.hoisted(() => ({
  getAccess: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("../../../authz/server", () => ({ getAccess }));
vi.mock("next/navigation", () => ({ notFound, redirect }));

describe("per-user detail page restriction", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([false, true])("denies the direct user detail URL with detail access %s", async (namesVisible) => {
    getAccess.mockResolvedValue({
      state: "authorized",
      breakGlass: false,
      principal: {},
      grants: [{ role: "admin", scope: "company", scope_value: "" }],
      namesVisible,
    });

    await expect(UserDetailsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it.each([
    ["signed-out", "/sign-in"],
    ["no-access", "/no-access"],
    ["unavailable", "/service-unavailable"],
  ] as const)("preserves %s auth routing", async (state, destination) => {
    getAccess.mockResolvedValue({ state, breakGlass: false });

    await expect(UserDetailsPage()).rejects.toThrow(`NEXT_REDIRECT:${destination}`);
    expect(redirect).toHaveBeenCalledWith(destination);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("fails closed to the outage page when access resolution throws", async () => {
    getAccess.mockRejectedValue(new Error("permissions unavailable"));

    await expect(UserDetailsPage()).rejects.toThrow("NEXT_REDIRECT:/service-unavailable");
    expect(redirect).toHaveBeenCalledWith("/service-unavailable");
    expect(notFound).not.toHaveBeenCalled();
  });
});
