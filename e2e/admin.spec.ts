import { test, expect, expectNoAxeViolations } from "./fixtures";
import { AUTH_OBJECTS_BY_PERSONA, AUTH_PRINCIPALS_BY_PERSONA } from "../scripts/integration/auth-seed";

test("admin ports explicit grant/revoke and the read-only administration panels", async ({ page, signInAs, consoleErrors }, info) => {
  await signInAs("admin");
  await page.getByRole("link", { name: "Administration", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Administration", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Grant Access", exact: true }).click();
  await page.getByLabel("Entra object ID", { exact: true }).fill(AUTH_OBJECTS_BY_PERSONA.manager);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("created");
  await page.getByLabel("Existing principal", { exact: true }).selectOption(AUTH_PRINCIPALS_BY_PERSONA.manager);
  await page.getByRole("button", { name: "Load grants" }).click();
  const selfGrant = page.getByRole("row").filter({ hasText: "self" });
  await expect(selfGrant).toContainText("user");
  await expectNoAxeViolations(page);
  await page.screenshot({ path: info.outputPath("admin-access.png"), fullPage: true });
  await selfGrant.getByRole("button", { name: "Revoke", exact: true }).click();
  await selfGrant.getByRole("button", { name: "Confirm revoke", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Access revoked.");

  for (const [section, label] of [
    ["hierarchy", "Manager Hierarchy"], ["audit", "Audit Log"], ["login-history", "Login History"],
    ["issues", "Issues Inbox"], ["health", "Health"], ["upstream", "Upstream Version"],
  ] as const) {
    await page.getByRole("link", { name: label, exact: true }).click();
    if (section === "hierarchy") {
      await expect(page.getByRole("button", { name: "Sync now" })).toBeDisabled();
      await expect(page.getByText("Manual sync is unavailable:", { exact: false })).toBeVisible();
    }
    if (section === "login-history") {
      await page.getByLabel("Numeric GitHub user ID").fill("1000001");
      await page.getByRole("button", { name: "Load history" }).click();
    }
    if (section === "audit") {
      await expect(page.getByRole("cell", { name: "grant.created", exact: true }).first()).toBeVisible();
      await expect(page.getByRole("cell", { name: "grant.revoked", exact: true }).first()).toBeVisible();
    }
    if (section === "health") await expect(page.getByText("SQL reachable: Yes", { exact: false })).toBeVisible();
    if (section === "upstream") await expect(page.getByText("Pinned upstream commit:", { exact: false })).toContainText(/[0-9a-f]{40}/);
    await expectNoAxeViolations(page);
    await page.screenshot({ path: info.outputPath(`admin-${section}.png`), fullPage: true });
  }
  expect(consoleErrors).toEqual([]);
});

for (const persona of ["manager", "member", "no-access"] as const) {
  test(`${persona} cannot open admin pages or any admin API`, async ({ page, signInAs, consoleErrors }, info) => {
    await signInAs(persona);
    await expect(page.getByRole("link", { name: "Administration", exact: true })).toHaveCount(0);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/no-access$/);
    for (const section of ["principals", "grants", "grant-form", "audit", "login-history", "issues", "hierarchy"]) {
      const response = await page.request.get(`/api/admin/${section}`);
      expect(response.status()).toBe(403);
    }
    for (const [path, method] of [["grants", "POST"], ["grants", "DELETE"], ["access", "POST"], ["issues/actions", "POST"]] as const) {
      const response = await page.request.fetch(`/api/admin/${path}`, { method, data: {} });
      expect(response.status()).toBe(403);
    }
    await expectNoAxeViolations(page);
    await page.screenshot({ path: info.outputPath(`admin-denied-${persona}.png`), fullPage: true });
    expect(consoleErrors).toEqual([]);
  });
}
