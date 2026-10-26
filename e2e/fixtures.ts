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
    page.on("requestfailed", (request) => {
      const failure = request.failure()?.errorText;
      if (failure !== "net::ERR_ABORTED") {
        errors.push(`${request.method()} ${request.url()}: ${failure ?? "request failed"}`);
      }
    });
    await use(errors);
  },
  signInAs: async ({ page }, use) => {
    await use(async (persona) => {
      await page.goto("/sign-in");
      const labels = { admin: "Test Admin", manager: "Test Manager", member: "Test Member", "no-access": "Test No Access" };
      await page.getByRole("button", { name: `Sign in as ${labels[persona]}`, exact: true }).click();
      await page.waitForURL(persona === "no-access" ? "/no-access" : "/");
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
