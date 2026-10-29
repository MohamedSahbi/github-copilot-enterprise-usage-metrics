import { defineConfig, devices } from "@playwright/test";
import { AUTH_TENANT } from "./scripts/integration/auth-seed";
import { e2eWebServerCommand } from "./scripts/e2e/web-server";

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "e2e",
  // Against a deployed URL only the unauthenticated smoke suite runs; the other specs need test sign-in (D-41).
  testMatch: process.env.BASE_URL ? "smoke/**/*.spec.ts" : process.env.E2E_SQL_OUTAGE ? "outage.spec.ts" : "**/*.spec.ts",
  testIgnore: !process.env.BASE_URL && !process.env.E2E_SQL_OUTAGE ? "outage.spec.ts" : undefined,
  fullyParallel: true,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  outputDir: "test-results",
  globalSetup: "./e2e/auth-setup.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Deployed smoke runs set BASE_URL and start no local server.
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: e2eWebServerCommand(port, process.env.E2E_DEV_BUNDLER),
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          E2E_TEST_AUTH: "1",
          AUTH_SECRET: "local-test-only-not-for-deployment",
          AUTH_TRUST_HOST: "true",
          // Canonical origin for same-origin mutation checks (admin, Feedback).
          AUTH_URL: baseURL,
          ENTRA_TENANT_ID: AUTH_TENANT,
          ACCESS_NO_ACCESS_MESSAGE: "Your account has no assigned portal permissions.",
          ACCESS_REQUEST_URL: "https://example.invalid/request-access",
          ACCESS_CONTACT: "Portal support",
          PER_USER_DETAIL_ENABLED: process.env.E2E_PER_USER_DETAIL_ENABLED === "1" ? "true" : "false",
          MODULE_UPSTREAM_VIEWS: process.env.E2E_UPSTREAM_VIEWS === "1" ? "true" : "false",
        },
      },
});
