import { expect, expectNoAxeViolations, test } from "./fixtures";

// Runs only with E2E_UPSTREAM_VIEWS=1 (MODULE_UPSTREAM_VIEWS=true); the default run keeps the Safe Alpha pages.
const pages = [
  { path: "/", title: "Overview" },
  { path: "/executive-summary", title: "Executive Summary" },
  { path: "/languages", title: "Languages" },
  { path: "/clients", title: "Clients" },
  { path: "/client-versions", title: "Client Versions" },
  { path: "/copilot-impact", title: "Copilot Impact" },
  { path: "/copilot-adoption", title: "Copilot Adoption" },
  { path: "/model-usage", title: "Model Usage" },
  { path: "/cli-adoption", title: "CLI Adoption" },
  { path: "/ai-adoption-phases", title: "AI Adoption Phases" },
];

test.describe("Upstream views from curated SQL", () => {
  test.skip(process.env.E2E_UPSTREAM_VIEWS !== "1", "MODULE_UPSTREAM_VIEWS is off");
  test.describe.configure({ mode: "serial" });

  test("admin sees every upstream view rendered from SQL", async ({ page, signInAs }) => {
    test.setTimeout(180_000);
    await signInAs("admin");
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    for (const route of pages) {
      const response = await page.goto(route.path);
      expect(response?.status(), route.path).toBe(200);
      await expect(nav.getByRole("link", { name: route.title, exact: true })).toBeVisible();
      await expect(page.getByText("Data unavailable")).toHaveCount(0);
      await expect(page.getByText(/too few users/i)).toHaveCount(0);
      await page.screenshot({ path: `test-results/screenshots/upstream-${route.title.toLowerCase().replaceAll(" ", "-")}.png`, fullPage: true });
    }
    await expectNoAxeViolations(page);
    const payload = await (await page.request.get("/languages")).text();
    expect(payload).not.toMatch(/example-user-\d+/);
  });

  test("member sees only their own data", async ({ page, signInAs }) => {
    await signInAs("member");
    const response = await page.goto("/languages");
    expect(response?.status()).toBe(200);
    await expect(page.getByLabel("Scope")).toHaveValue("self:self");
    await expect(page.getByText("Data unavailable")).toHaveCount(0);
  });

  test("Users stays hidden without per-user detail", async ({ page, signInAs }) => {
    test.skip(process.env.E2E_PER_USER_DETAIL_ENABLED === "1", "per-user detail is on");
    await signInAs("admin");
    expect((await page.goto("/users"))?.status()).toBe(404);
  });
});
