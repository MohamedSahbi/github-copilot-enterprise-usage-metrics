import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("terminates the Node process before Next.js can swallow a production guard error", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    "import { validateStartup } from './portal/src/auth/startup.ts'; validateStartup(); console.log('unexpected-start');"], {
    env: { ...process.env, NODE_ENV: "production", E2E_TEST_AUTH: "1" },
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("E2E_TEST_AUTH must not be enabled in a production deployment");
  expect(result.stdout).not.toContain("unexpected-start");
});
