import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page } from "@playwright/test";

type Persona = "admin" | "manager" | "member" | "no-access";

export const test = base.extend<{
  signInAs: (persona: Persona) => Promise<void>;
  consoleErrors: string[];
}>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await use(errors);
  },
  signInAs: async ({ page }, use) => {
    await use(async (persona) => {
      const response = await page.request.post("/api/test-auth", { data: { persona } });
      expect(response.ok()).toBe(true);
    });
  },
});

export { expect };

// Upstream chart canvas has no accessible name and upstream cannot be edited (D-14); tracked in issue #1.
const KNOWN_UPSTREAM_AXE_RULES = ["role-img-alt"];

export async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .disableRules(KNOWN_UPSTREAM_AXE_RULES)
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}
