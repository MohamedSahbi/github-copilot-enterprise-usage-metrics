import { beforeEach, describe, expect, it, vi } from "vitest";
import FeatureAdoptionPocPage from "./page";

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

describe("feature adoption proof-of-concept route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("denies an authorized viewer instead of rendering an extra chart", async () => {
    getAccess.mockResolvedValue({
      state: "authorized",
      breakGlass: false,
      principal: {},
      grants: [{ role: "admin", scope: "company", scope_value: "" }],
      namesVisible: true,
    });

    await expect(FeatureAdoptionPocPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each([
    ["signed-out", "/sign-in"],
    ["no-access", "/no-access"],
    ["unavailable", "/service-unavailable"],
  ] as const)("preserves %s auth routing", async (state, destination) => {
    getAccess.mockResolvedValue({ state, breakGlass: false });

    await expect(FeatureAdoptionPocPage()).rejects.toThrow(`NEXT_REDIRECT:${destination}`);
    expect(redirect).toHaveBeenCalledWith(destination);
  });
});
