import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openPool: vi.fn(),
  seedAuth: vi.fn(),
  waitForLocalSignInRoute: vi.fn(),
}));

vi.mock("../integration/db", () => ({ openPool: mocks.openPool }));
vi.mock("../integration/auth-seed", () => ({ seedAuth: mocks.seedAuth }));
vi.mock(import("./route-readiness"), async (importOriginal) => ({
  ...await importOriginal(),
  waitForLocalSignInRoute: mocks.waitForLocalSignInRoute,
}));

import setup from "../../e2e/auth-setup";

const savedEnvironment = new Map<string, string | undefined>();
const environmentKeys = ["BASE_URL", "E2E_SQL_OUTAGE", "E2E_PORT"];

beforeEach(() => {
  for (const key of environmentKeys) {
    savedEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.E2E_PORT = "3107";
  vi.clearAllMocks();
  mocks.seedAuth.mockResolvedValue(undefined);
  mocks.waitForLocalSignInRoute.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const key of environmentKeys) {
    const value = savedEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Playwright auth setup", () => {
  it("runs readiness once after the auth seed and pool close", async () => {
    const pool = { close: vi.fn().mockResolvedValue(undefined) };
    mocks.openPool.mockResolvedValue(pool);

    await setup();

    expect(mocks.openPool).toHaveBeenCalledTimes(1);
    expect(mocks.seedAuth).toHaveBeenCalledWith(pool);
    expect(pool.close).toHaveBeenCalledTimes(1);
    expect(mocks.waitForLocalSignInRoute).toHaveBeenCalledExactlyOnceWith("127.0.0.1", 3107);
    expect(mocks.seedAuth.mock.invocationCallOrder[0]).toBeLessThan(pool.close.mock.invocationCallOrder[0]!);
    expect(pool.close.mock.invocationCallOrder[0]).toBeLessThan(mocks.waitForLocalSignInRoute.mock.invocationCallOrder[0]!);
  });

  it("does not request readiness when auth seeding fails", async () => {
    const pool = { close: vi.fn().mockResolvedValue(undefined) };
    const seedFailure = new Error("synthetic auth seed failure");
    mocks.openPool.mockResolvedValue(pool);
    mocks.seedAuth.mockRejectedValue(seedFailure);

    await expect(setup()).rejects.toBe(seedFailure);

    expect(pool.close).toHaveBeenCalledTimes(1);
    expect(mocks.waitForLocalSignInRoute).not.toHaveBeenCalled();
  });

  it("does not request readiness when closing the seed connection fails", async () => {
    const poolFailure = new Error("synthetic pool close failure");
    const pool = { close: vi.fn().mockRejectedValue(poolFailure) };
    mocks.openPool.mockResolvedValue(pool);

    await expect(setup()).rejects.toBe(poolFailure);

    expect(mocks.waitForLocalSignInRoute).not.toHaveBeenCalled();
  });

  it("stops setup when sign-in readiness fails", async () => {
    const pool = { close: vi.fn().mockResolvedValue(undefined) };
    const readinessFailure = new Error("synthetic server-exit request failure");
    mocks.openPool.mockResolvedValue(pool);
    mocks.waitForLocalSignInRoute.mockRejectedValue(readinessFailure);

    await expect(setup()).rejects.toBe(readinessFailure);
    expect(mocks.waitForLocalSignInRoute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["deployed BASE_URL", "BASE_URL"],
    ["intentional SQL outage", "E2E_SQL_OUTAGE"],
  ])("does not seed or request readiness for %s", async (_label, variable) => {
    process.env[variable] = variable === "BASE_URL" ? "https://portal.example.invalid" : "1";

    await setup();

    expect(mocks.openPool).not.toHaveBeenCalled();
    expect(mocks.seedAuth).not.toHaveBeenCalled();
    expect(mocks.waitForLocalSignInRoute).not.toHaveBeenCalled();
  });
});
