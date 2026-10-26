import { expect, expectNoAxeViolations, test } from "./fixtures";

test("signed-in test persona cannot render the excluded Feature Adoption proof of concept", async ({
  page,
  signInAs,
  consoleErrors,
}) => {
  await signInAs("admin");
  expect(consoleErrors).toEqual([]);
  const response = await page.goto("/poc/feature-adoption");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Feature Adoption Funnel" })).toHaveCount(0);

  await expectNoAxeViolations(page);
  await page.screenshot({ path: "test-results/screenshots/poc-feature-adoption.png", fullPage: true });
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
