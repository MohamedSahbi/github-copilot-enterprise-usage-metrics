import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { UserUsageResponse } from "../shared/src/api";
import { expect, expectNoAxeViolations, test } from "./fixtures";

const aggregatePages = [
  { path: "/", title: "Overview" },
  { path: "/copilot-adoption", title: "Copilot Adoption" },
  { path: "/languages", title: "Languages" },
  { path: "/model-usage", title: "Model Usage" },
  { path: "/cli-adoption", title: "CLI Adoption" },
  { path: "/copilot-impact", title: "Copilot Impact" },
];

const managerPages = [
  ...aggregatePages,
  { path: "/executive-summary", title: "Executive Summary" },
  { path: "/clients", title: "Clients" },
  { path: "/client-versions", title: "Client Versions" },
  { path: "/ai-adoption-phases", title: "AI Adoption Phases" },
];

test.describe("core pages by persona", () => {
  test.describe.configure({ mode: "serial" });

  for (const persona of ["admin", "manager", "member"] as const) {
    test(`${persona} can browse its scoped core pages accessibly`, async ({
      page,
      signInAs,
      consoleErrors,
    }) => {
      test.setTimeout(120_000);
      await signInAs(persona);
      const pages = persona === "member" ? aggregatePages : managerPages;
      await mkdir("test-results/screenshots", { recursive: true });

      for (const [index, route] of pages.entries()) {
        await page.goto(route.path);
        await expect(page.getByRole("heading", { name: route.title, exact: true }).first()).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
        if (persona === "admin" && route.path === "/copilot-adoption") {
          for (const category of ["VS Code Agents", "Copilot App", "Cloud Agent", "Code Review", "Advanced Users"]) {
            await expect(page.getByText(category, { exact: true }).first()).toBeVisible();
          }
        }
        if (route.path === "/ai-adoption-phases") {
          if (persona === "admin") {
            await expect(page.getByText("Not reported · 9", { exact: true })).toBeVisible();
          } else {
            await expect(page.getByText("Metrics are hidden because this scope is smaller than the minimum group size.")).toBeVisible();
          }
        }
        await expectNoAxeViolations(page);
        await page.screenshot({
          path: join("test-results/screenshots", `${persona}-${index + 1}-${route.title.toLowerCase().replaceAll(" ", "-")}.png`),
          fullPage: true,
        });
      }
      if (persona === "manager") {
        await page.goto("/");
        await expect(page.getByRole("heading", { name: "Overview", exact: true }).last()).toBeVisible();
        await page.getByLabel("Scope").selectOption("department:department-a");
        await page.getByRole("button", { name: "Apply" }).click();
        await expect(page).toHaveURL(/scope=department%3Adepartment-a/);
        await expect(page.getByText("Metrics are hidden because this scope is smaller than the minimum group size.")).toBeVisible();
        await expectNoAxeViolations(page);
        await page.screenshot({
          path: "test-results/screenshots/manager-department-a-suppressed.png",
          fullPage: true,
        });
        await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Languages" }).click();
        await expect(page).toHaveURL(/scope=department%3Adepartment-a/);
        await expect(page.getByLabel("Scope")).toHaveValue("department:department-a");
        await expect(page.getByText("Metrics are hidden because this scope is smaller than the minimum group size.")).toBeVisible();
        await expectNoAxeViolations(page);
      }
      if (persona === "member") {
        await expect(page.getByText("Metrics are hidden because this scope is smaller than the minimum group size.")).toHaveCount(1);
        await expect(page.getByText(/observed users in the selected scope/)).toHaveCount(0);
        await expect(page.getByLabel("Scope")).toHaveValue("self:self");
        await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Users" })).toHaveCount(0);
        await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Executive Summary" })).toHaveCount(0);
        const usersResponse = await page.request.get("/users");
        expect(usersResponse.status()).toBe(404);
      }
      expect(consoleErrors).toEqual([]);
    });

  }

  test("member cannot read a different user's details outside its self grant", async ({ page, signInAs }) => {
    test.skip(process.env.E2E_PER_USER_DETAIL_ENABLED !== "1", "run in the scoped user-detail E2E configuration");
    test.setTimeout(60_000);
    await signInAs("member");

    const ownDetails = await page.goto("/users/1000006");
    expect(ownDetails?.status()).toBe(200);
    const otherUserDetails = await page.goto("/users/1000001");
    expect(otherUserDetails?.status()).toBe(404);
  });
});

test("no-access persona receives no core navigation or metrics", async ({ page, signInAs, consoleErrors }) => {
  await signInAs("no-access");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "No access" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(0);
  await expectNoAxeViolations(page);
  await page.screenshot({ path: "test-results/screenshots/no-access.png", fullPage: true });
  expect(consoleErrors).toEqual([]);
});

test("aggregate-only mode hides per-user pages and details", async ({
  page,
  signInAs,
  consoleErrors,
}) => {
  test.setTimeout(60_000);
  await signInAs("admin");
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation.getByRole("link", { name: "Users" })).toHaveCount(0);
  await expectNoAxeViolations(page);
  await mkdir("test-results/screenshots", { recursive: true });
  await page.screenshot({
    path: "test-results/screenshots/admin-aggregate-only.png",
    fullPage: true,
  });

  const usersResponse = await page.request.get("/users");
  expect(usersResponse.status()).toBe(404);
  const userDetailsResponse = await page.request.get("/users/1000001");
  expect(userDetailsResponse.status()).toBe(404);
  expect(consoleErrors).toEqual([]);
});

for (const persona of ["admin", "manager"] as const) {
  test(`${persona} sees exact credit API text formatted in the scoped Users table`, async ({
    page,
    signInAs,
    consoleErrors,
  }) => {
    test.skip(process.env.E2E_PER_USER_DETAIL_ENABLED !== "1", "run in the scoped user-detail E2E configuration");
    test.setTimeout(60_000);
    await signInAs(persona);

    const usersResponse = await page.request.get("/api/users?period=last_7_days");
    expect(usersResponse.status()).toBe(200);
    const users = await usersResponse.json() as UserUsageResponse;
    expect(users.data.length).toBeGreaterThan(0);
    expect(users.data.every(({ aiCreditsUsed }) => typeof aiCreditsUsed === "string")).toBe(true);

    await page.goto("/users");
    await expect(page.getByRole("heading", { name: "Users", exact: true }).last()).toBeVisible();
    const firstUser = users.data[0];
    if (!firstUser) throw new Error("The authorized users response was empty");
    const userRow = page.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: firstUser.login ?? `User ${firstUser.userId}`, exact: true }),
    });
    const displayedCredits = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })
      .format(Number(firstUser.aiCreditsUsed));
    await expect(userRow.getByRole("cell").last()).toHaveText(displayedCredits);
    await expectNoAxeViolations(page);
    await mkdir("test-results/screenshots", { recursive: true });
    await page.screenshot({
      path: `test-results/screenshots/${persona}-users-exact-credits.png`,
      fullPage: true,
    });
    expect(consoleErrors).toEqual([]);
  });
}
