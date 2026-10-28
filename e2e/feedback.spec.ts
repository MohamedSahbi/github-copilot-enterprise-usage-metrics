import { mkdir } from "node:fs/promises";
import { test, expect, expectNoAxeViolations } from "./fixtures";
import { openPool } from "../scripts/integration/db";
import { cleanupFeedback, seedFeedback } from "../scripts/integration/feedback-seed";

const flagOn = process.env.MODULE_FEEDBACK === "true";
const personas = ["admin", "manager", "member"] as const;

test.describe("Feedback compatible list and vote slice (flag on)", () => {
  test.skip(!flagOn, "Requires MODULE_FEEDBACK=true");
  test.describe.configure({ mode: "serial" });
  let ids: number[];
  test.beforeAll(async () => {
    const pool = await openPool();
    try { ids = await seedFeedback(pool); } finally { await pool.close(); }
    await mkdir("test-results/screenshots", { recursive: true });
  });
  test.afterAll(async () => {
    if (!ids) return;
    const pool = await openPool();
    try { await cleanupFeedback(pool, ids); } finally { await pool.close(); }
  });
  for (const persona of personas) {
    test(`${persona} sees only public or authorized private feedback`, async ({ page, signInAs, consoleErrors }) => {
      await signInAs(persona);
      await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Feedback", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Feedback", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Public feedback example" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Private admin feedback" })).toHaveCount(persona === "admin" ? 1 : 0);
      await expect(page.getByRole("heading", { name: "Private member feedback" })).toHaveCount(persona === "manager" ? 0 : 1);
      await expect(page.getByRole("status")).toContainText("New submissions");
      await page.getByRole("button", { name: `Toggle vote for feedback ${ids[0]}`, exact: true }).click();
      await expect(page.getByRole("button", { name: `Toggle vote for feedback ${ids[0]}`, exact: true })).toContainText("(1)");
      await page.getByRole("button", { name: `Toggle vote for feedback ${ids[0]}`, exact: true }).click();
      await expect(page.getByRole("button", { name: `Toggle vote for feedback ${ids[0]}`, exact: true })).toContainText("(0)");
      await expectNoAxeViolations(page);
      await page.screenshot({ path: `test-results/screenshots/feedback-${persona}-on.png`, fullPage: true });
      expect(consoleErrors).toEqual([]);
    });
  }
  test("no-access caller is denied even with the flag enabled", async ({ page, signInAs, consoleErrors }) => {
    await signInAs("no-access");
    await page.goto("/feedback");
    await expect(page).toHaveURL(/\/no-access$/);
    await expectNoAxeViolations(page);
    await page.screenshot({ path: "test-results/screenshots/feedback-no-access.png", fullPage: true });
    expect(consoleErrors).toEqual([]);
  });
});

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
