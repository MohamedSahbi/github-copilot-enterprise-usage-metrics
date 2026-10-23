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

test("without sign-in the page shows the signed-out state", async ({ page }) => {
  await page.goto("/poc/feature-adoption");
  await expect(page.getByText(/Signed out/)).toBeVisible();
});
