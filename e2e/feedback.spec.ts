import { mkdir } from "node:fs/promises";
import { test, expect, expectNoAxeViolations } from "./fixtures";

// The Feedback page was removed from the portal UI until submissions exist; the API stays behind MODULE_FEEDBACK.
const flagOn = process.env.MODULE_FEEDBACK === "true";
const personas = ["admin", "manager", "member"] as const;

// Flag off: no SQL seeding; the module must be hidden and its page and API disabled for authorized callers.
test.describe("Feedback hidden when the flag is off", () => {
  test.skip(flagOn, "Requires MODULE_FEEDBACK unset or false");
  test.beforeAll(async () => {
    await mkdir("test-results/screenshots", { recursive: true });
  });
  for (const persona of personas) {
    test(`${persona} has no Feedback navigation, page or API`, async ({ page, signInAs, consoleErrors }) => {
      await signInAs(persona);
      await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Feedback", exact: true })).toHaveCount(0);
      expect((await page.request.get("/feedback")).status()).toBe(404);
      const origin = new URL(page.url()).origin;
      for (const response of [
        await page.request.get("/api/feedback"),
        await page.request.post("/api/feedback/1/vote", { headers: { origin } }),
      ]) {
        expect(response.status()).toBe(404);
        expect((await response.json()).error.code).toBe("module_disabled");
      }
      await expectNoAxeViolations(page);
      await page.screenshot({ path: `test-results/screenshots/feedback-${persona}-off.png`, fullPage: true });
      expect(consoleErrors).toEqual([]);
    });
  }
});
