import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

test("signed out redirects to sign-in and offers both providers", async ({ page, consoleErrors }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("button", { name: "Sign in with Microsoft Entra ID" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "test-results/screenshots/signed-out.png", fullPage: true });
  expect(consoleErrors).toEqual([]);
});

for (const persona of ["admin", "manager", "member", "no-access"] as const) {
  test(`${persona} has the correct signed-in access state`, async ({ page, signInAs, consoleErrors }) => {
    await signInAs(persona);
    await expect(page.getByRole("heading", { name: persona === "no-access" ? "No access" : "GitHub Copilot Usage Metrics" })).toBeVisible();
    if (persona === "no-access") {
      await expect(page.getByText("Your account has no assigned portal permissions.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Request access" })).toHaveAttribute("href", "https://example.invalid/request-access");
      await expect(page.getByText("Contact: Portal support")).toBeVisible();
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `test-results/screenshots/${persona}.png`, fullPage: true });
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(consoleErrors).toEqual([]);
  });
}

test("outage page never suggests requesting access", async ({ page, consoleErrors }) => {
  await page.goto("/service-unavailable");
  await expect(page.getByRole("heading", { name: "Service unavailable" })).toBeVisible();
  await expect(page.getByText(/request access/i)).toHaveCount(0);
  await expect(page.getByText("Contact: Portal support")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "test-results/screenshots/outage.png", fullPage: true });
  expect(consoleErrors).toEqual([]);
});
