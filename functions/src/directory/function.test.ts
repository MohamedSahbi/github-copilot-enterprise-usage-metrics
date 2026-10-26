import { afterEach, describe, expect, it, vi } from "vitest";

const timer = vi.fn();
vi.mock("@azure/functions", () => ({ app: { timer } }));

const requiredEnvironment: Record<string, string> = {
  DIRECTORY_PROVIDER: "entra",
  DIRECTORY_DEPARTMENT_ATTRIBUTE: "",
  DIRECTORY_BUSINESS_AREA_ATTRIBUTE: "",
  ENTERPRISE_SLUG: "fixture-enterprise",
  ORGANIZATIONS: "fixture-org",
  SQL_SERVER: "fixture.database.windows.net",
  SQL_DATABASE: "fixture-database",
  AZURE_CLIENT_ID: "00000000-0000-0000-0000-000000000001",
  GITHUB_DIRECTORY_PAT: "fixture-secret",
};
const originalValues = new Map<string, string | undefined>();

describe("directory Functions v4 registration", () => {
  afterEach(() => {
    for (const [key, value] of originalValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalValues.clear();
    timer.mockReset();
    vi.resetModules();
  });

  it("registers the production runtime handler with the required operator schedule setting", async () => {
    for (const [key, value] of Object.entries(requiredEnvironment)) {
      originalValues.set(key, process.env[key]);
      process.env[key] = value;
    }

    await import("./function.js");

    expect(timer).toHaveBeenCalledTimes(1);
    expect(timer).toHaveBeenCalledWith("directorySync", expect.objectContaining({
      schedule: "%DIRECTORY_SYNC_SCHEDULE%",
      runOnStartup: false,
      handler: expect.any(Function),
    }));
  });
});
