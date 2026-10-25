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
    page.on("requestfailed", (request) => errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "request failed"}`));
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

export async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations.map((violation) => ({
    id: violation.id,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      failureSummary: node.failureSummary,
    })),
  }))).toEqual([]);
}
