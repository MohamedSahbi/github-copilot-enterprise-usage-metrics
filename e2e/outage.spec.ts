import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

test("a real SQL connection failure redirects an authenticated user to outage, not No access", async ({ page, consoleErrors }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in as Test Admin", exact: true }).click();
  await expect(page).toHaveURL(/\/service-unavailable$/, { timeout: 30000 });
  await expect(page.getByRole("heading", { name: "Service unavailable" })).toBeVisible();
  await expect(page.getByText(/request access/i)).toHaveCount(0);
  await expect(page.getByText("Contact: Portal support")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "test-results/screenshots/sql-outage.png", fullPage: true });
  await page.goto("/poc/feature-adoption");
  await expect(page).toHaveURL(/\/service-unavailable$/, { timeout: 30000 });
  expect(consoleErrors).toEqual([]);
});
