import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

test("FAQ is public, sectioned, and has working answer and Why links", async ({ page, consoleErrors }) => {
  await page.goto("/help");
  await expect(page.getByRole("heading", { name: "Portal FAQ", exact: true })).toBeVisible();
  for (const name of ["Data", "Access", "Features", "Privacy"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  const links = await page.getByRole("link").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("href") ?? ""),
  );
  for (const href of links.filter((href) => href.startsWith("#"))) {
    expect(await page.evaluate((hash) => document.getElementById(decodeURIComponent(hash.slice(1))) !== null, href), href).toBe(true);
  }
  await expect(page.getByRole("link", { name: "D-17 fail-closed behavior, §13.1" })).toHaveAttribute(
    "href",
    "https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/blob/main/docs/architecture/decision-record.md#131-security",
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "test-results/screenshots/faq-public.png", fullPage: true });
  expect(consoleErrors).toEqual([]);
});

for (const persona of ["admin", "manager", "member", "no-access"] as const) {
  test(`${persona} can follow the appropriate Help / FAQ link`, async ({ page, signInAs, consoleErrors }) => {
    test.setTimeout(120_000);
    await signInAs(persona);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `test-results/screenshots/faq-${persona}-entry.png`, fullPage: true });
    const link = page.getByRole("link", {
      name: persona === "no-access" ? "Help / FAQ: Why do I see No access?" : "Help / FAQ",
      exact: true,
    });
    await expect(link).toHaveAttribute("href", persona === "no-access" ? "/help#why-do-i-see-no-access" : "/help");
    await link.click();
    await expect(page).toHaveURL(persona === "no-access" ? /\/help#why-do-i-see-no-access$/ : /\/help$/);
    await expect(page.getByRole("heading", { name: "Why do I see No access?", exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
}

test("unavailable page links to the service answer without requesting access", async ({ page, consoleErrors }) => {
  await page.goto("/service-unavailable");
  await expect(page.getByRole("link", { name: /request access/i })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("link", { name: "Help / FAQ: Why is the service unavailable?" }).click();
  await expect(page).toHaveURL(/\/help#why-is-the-service-unavailable$/);
  await expect(page.getByRole("heading", { name: "Why is the service unavailable?", exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "test-results/screenshots/faq-unavailable-answer.png", fullPage: true });
  expect(consoleErrors).toEqual([]);
});
