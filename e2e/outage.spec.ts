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

test("SQL outage denies standalone Flight and usage APIs for an authenticated session", async ({ page, consoleErrors }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in as Test Admin", exact: true }).click();
  await expect(page).toHaveURL(/\/service-unavailable$/, { timeout: 30000 });
  const flightHeaders: Record<string, string>[] = [
    { RSC: "1" },
    { RSC: "1", "Next-Router-Prefetch": "1" },
    { RSC: "1", "Next-Router-State-Tree": encodeURIComponent(JSON.stringify(["", { children: ["__PAGE__", {}] }, null, "refetch"])) },
  ];
  for (const headers of flightHeaders) {
    let response = await page.request.get("/", { headers, maxRedirects: 0 });
    if (response.status() === 307 && response.headers().location?.startsWith("/?")) {
      const original = new URL(response.url());
      const normalized = new URL(response.headers().location!, original);
      expect(normalized.origin).toBe(original.origin);
      expect(normalized.pathname).toBe(original.pathname);
      expect(normalized.hash).toBe("");
      expect(normalized.searchParams.getAll("_rsc")).toHaveLength(1);
      normalized.searchParams.delete("_rsc");
      expect(normalized.search).toBe(original.search);
      expect(await response.text()).toBe("");
      await testInfo.attach(`outage-${Object.keys(headers).join("-")}-normalization.json`, {
        body: JSON.stringify({ url: response.url(), status: 307, location: response.headers().location }),
        contentType: "application/json",
      });
      response = await page.request.get(new URL(response.headers().location!, original).href, { headers, maxRedirects: 0 });
    }
    const payload = await response.text();
    await testInfo.attach(`outage-${Object.keys(headers).join("-")}.flight`, {
      body: JSON.stringify({ status: response.status(), location: response.headers().location, body: payload }),
      contentType: "application/json",
    });
    expect(payload).not.toContain("Daily usage overview");
    if (response.status() === 307) expect(response.headers().location).toBe("/service-unavailable");
    else {
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/x-component");
      if (!headers["Next-Router-Prefetch"]) expect(payload).toContain("NEXT_REDIRECT;replace;/service-unavailable;307;");
    }
  }
  for (const path of ["/api/usage/overview", "/api/usage/breakdown", "/api/users"]) {
    const response = await page.request.get(path);
    expect(response.status()).toBe(503);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(response.headers()["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/i);
  }
  expect(consoleErrors).toEqual([]);
});
