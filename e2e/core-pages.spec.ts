import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, expectNoAxeViolations, test } from "./fixtures";

const releasedPages = [
  { path: "/", title: "Overview" },
  { path: "/copilot-impact", title: "Copilot Impact" },
];

const excludedPages = [
  "/executive-summary",
  "/copilot-adoption",
  "/languages",
  "/model-usage",
  "/cli-adoption",
  "/clients",
  "/client-versions",
  "/ai-adoption-phases",
  "/users",
  "/executivesummary",
  "/poc/feature-adoption",
];

const deniedUsageApis = [
  "/api/usage/overview",
  "/api/usage/overview?from=invalid&to=invalid",
  "/api/usage/breakdown",
  "/api/usage/breakdown?kind=invalid&pageSize=999",
  "/api/users",
  "/api/users?period=invalid&page=0",
];

test.describe("Safe Alpha core pages by persona", () => {
  test.describe.configure({ mode: "serial" });

  for (const persona of ["admin", "manager", "member"] as const) {
    test(`${persona} sees only released pages and grant-backed scopes`, async ({
      page,
      signInAs,
      consoleErrors,
    }) => {
      test.setTimeout(120_000);
      await signInAs(persona);
      await mkdir("test-results/screenshots", { recursive: true });

      const expectedScope = { admin: "all:all", manager: "team:team", member: "self:self" }[persona];
      for (const [index, route] of releasedPages.entries()) {
        const pageResponse = await page.goto(route.path);
        if (!pageResponse) throw new Error(`No document response for ${route.path}`);
        expect(pageResponse.status()).toBe(200);
        const renderedPayload = await pageResponse.text();
        expect(renderedPayload).not.toMatch(
          /"(?:completionUsers|completionOnlyUsers|chatUsers|agentModeUsers|askModeUsers|inlineModeUsers|planModeUsers|cliUsers|appUsers|vscodeAgentUsers|codingAgentUsers|codeReviewUsers|advancedUsers|userCount|suppressed)"\s*:/,
        );
        await expect(page.getByRole("heading", { name: route.title, exact: true }).first()).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link")).toHaveCount(2);
        await expect(page.getByLabel("Scope")).toHaveValue(expectedScope);
        await expect(page.getByRole("option")).toHaveCount(1);
        await expect(page.getByText(
          "Metrics may be limited by the deployment's minimum-group privacy controls.",
          { exact: true },
        )).toHaveCount(1);
        await expect(page.getByText(/observed users in the selected scope/i)).toHaveCount(0);
        await expectNoAxeViolations(page);
        await page.screenshot({
          path: join("test-results/screenshots", `${persona}-${index + 1}-${route.title.toLowerCase().replaceAll(" ", "-")}.png`),
          fullPage: true,
        });
      }

      expect(consoleErrors).toEqual([]);
      const excludedPage = await page.goto("/executive-summary");
      expect(excludedPage?.status()).toBe(404);
      await expectNoAxeViolations(page);
      for (const path of excludedPages.slice(1)) {
        expect((await page.request.get(path)).status()).toBe(404);
      }

      for (const path of deniedUsageApis) {
        const response = await page.request.get(path);
        expect(response.status()).toBe(404);
        expect(response.headers()["cache-control"]).toBe("private, no-store");
        expect(await response.json()).toMatchObject({
          error: { code: "not_found", message: "The requested resource is not available." },
        });
      }

      if (persona === "manager") {
        for (const scope of ["team:team-1", "department:stale", ""]) {
          expect((await page.request.get(`/?scope=${encodeURIComponent(scope)}`)).status()).toBe(404);
        }
        expect((await page.request.get("/?scope=team%3Ateam&scope=team%3Ateam")).status()).toBe(404);
      }
    });
  }

  test("per-user detail URLs remain unavailable regardless of deployment detail access", async ({
    page,
    signInAs,
  }) => {
    await signInAs("admin");

    expect((await page.request.get("/users/1000001")).status()).toBe(404);
    expect((await page.request.get("/users/1000006")).status()).toBe(404);
    expect((await page.request.get("/api/users?period=last_7_days")).status()).toBe(404);
  });
});

test("no-access persona receives no core navigation or usage data", async ({ page, signInAs, consoleErrors }) => {
  await signInAs("no-access");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No access" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
  for (const path of ["/api/usage/overview", "/api/usage/breakdown", "/api/users"]) {
    expect((await page.request.get(path)).status()).toBe(403);
  }
  await expectNoAxeViolations(page);
  await mkdir("test-results/screenshots", { recursive: true });
  await page.screenshot({ path: "test-results/screenshots/no-access.png", fullPage: true });
  expect(consoleErrors).toEqual([]);
});
