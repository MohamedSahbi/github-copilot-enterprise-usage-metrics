import { expect, test } from "./fixtures";

test("test sign-in rejects unknown personas", async ({ request }) => {
  const response = await request.post("/api/test-auth", { data: { persona: "root" } });
  expect(response.status()).toBe(400);
});
