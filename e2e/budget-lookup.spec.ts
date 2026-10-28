import { expect, expectNoAxeViolations, test } from "./fixtures";

const enabled = process.env.MODULE_BUDGET_LOOKUP === "true";
const data = {
  userId: 990085001,
  amountUnit: "USD",
  cycle: "calendar_month_utc",
  budgets: [
    {
      id: "synthetic-individual",
      kind: "individual",
      amount: "125.5",
      consumedAmount: { status: "reported", amount: "0", unit: "USD" },
      expiresAt: "2027-01-01",
    },
    {
      id: "synthetic-default",
      kind: "default_per_user",
      amount: "300",
      consumedAmount: { status: "not_reported" },
      expiresAt: null,
    },
  ],
  effectiveBudget: {
    status: "reported",
    budgetId: "synthetic-individual",
    amount: "125.5",
    consumedAmount: { status: "reported", amount: "0", unit: "USD" },
  },
};

for (const persona of ["admin", "manager", "member"] as const) {
  test(`Budget Lookup visibility and mocked display for ${persona}`, async ({
    page, signInAs, consoleErrors,
  }) => {
    let requests = 0;
    await page.route("**/api/budget-lookup*", async (route) => {
      requests += 1;
      expect(route.request().method()).toBe("GET");
      await route.fulfill({ json: { data } });
    });
    await signInAs(persona);
    const link = page.getByRole("link", { name: "Budget Lookup", exact: true });
    if (!enabled) {
      await expect(link).toHaveCount(0);
      expect(requests).toBe(0);
    } else {
      await link.click();
      await expect(page.getByRole("heading", { name: "Budget Lookup", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: `Budget data for user ${data.userId}` })).toBeVisible();
      await expect(page.getByRole("rowheader", { name: "Individual", exact: true })).toBeVisible();
      await expect(page.getByRole("rowheader", { name: "Default per user", exact: true })).toBeVisible();
      await expect(page.getByRole("cell", { name: "USD 0", exact: true })).toBeVisible();
      await expect(page.getByRole("cell", { name: "Not reported", exact: true })).toBeVisible();
      const beforeInvalidInput = requests;
      await page.getByRole("textbox", { name: "GitHub user ID", exact: true }).fill("not-a-number");
      await page.getByRole("button", { name: "Look up budget", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Enter a positive numeric GitHub user ID." }))
        .toHaveText("Enter a positive numeric GitHub user ID.");
      expect(requests).toBe(beforeInvalidInput);
    }
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: `test-results/screenshots/budget-${enabled ? "enabled" : "disabled"}-${persona}.png`,
      fullPage: true,
    });
    expect(consoleErrors).toEqual([]);
  });
}

test("Budget Lookup does not request data for a no-access persona", async ({
  page, signInAs, consoleErrors,
}) => {
  let requests = 0;
  await page.route("**/api/budget-lookup*", async (route) => {
    requests += 1;
    await route.abort();
  });
  await signInAs("no-access");
  await expect(page.getByRole("link", { name: "Budget Lookup", exact: true })).toHaveCount(0);
  if (enabled) {
    await page.goto("/budget-lookup");
    await expect(page).toHaveURL(/\/no-access$/);
  }
  expect(requests).toBe(0);
  await expectNoAxeViolations(page);
  await page.screenshot({ path: "test-results/screenshots/budget-no-access.png", fullPage: true });
  expect(consoleErrors).toEqual([]);
});

test("Budget Lookup redirects signed-out visitors before requesting data", async ({ page, consoleErrors }) => {
  test.skip(!enabled, "The flag-on run covers the authenticated page boundary.");
  let requests = 0;
  await page.route("**/api/budget-lookup*", async (route) => {
    requests += 1;
    await route.abort();
  });
  await page.goto("/budget-lookup");
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(requests).toBe(0);
  await expectNoAxeViolations(page);
  await page.screenshot({ path: "test-results/screenshots/budget-signed-out.png", fullPage: true });
  expect(consoleErrors).toEqual([]);
});
