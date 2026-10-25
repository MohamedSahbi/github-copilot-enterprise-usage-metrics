import { expect, expectNoAxeViolations, test } from "./fixtures";

test("signed-in test persona sees the upstream Feature Adoption chart without console errors", async ({
  page,
  signInAs,
  consoleErrors,
}) => {
  await signInAs("admin");
  await page.goto("/poc/feature-adoption");

  await expect(page.getByText("Signed in as Test Admin")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Feature Adoption Funnel" })).toBeVisible();
  await expect(page.getByText("110 users").first()).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();

  await expectNoAxeViolations(page);
  await page.screenshot({ path: "test-results/screenshots/poc-feature-adoption.png", fullPage: true });
  expect(consoleErrors).toEqual([]);
});

test("without sign-in the PoC redirects to sign-in", async ({ page }) => {
  await page.goto("/poc/feature-adoption");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("no-access persona cannot bypass access routing through the PoC", async ({ page, signInAs }) => {
  await signInAs("no-access");
  await page.goto("/poc/feature-adoption");
  await expect(page).toHaveURL(/\/no-access$/);
});
