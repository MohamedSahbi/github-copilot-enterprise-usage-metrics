import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "e2e",
  // Against a deployed URL only the unauthenticated smoke suite runs; the other specs need test sign-in (D-41).
  testMatch: process.env.BASE_URL ? "smoke/**/*.spec.ts" : "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  outputDir: "test-results",
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
        command: "npm run dev -w portal -- --port " + port,
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        env: { E2E_TEST_AUTH: "1" },
      },
});
