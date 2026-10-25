import { expect, test } from "./fixtures";

test("test sign-in rejects unknown personas", async ({ request }) => {
  const response = await request.get("/api/auth/csrf");
  const { csrfToken } = await response.json();
  const rejected = await request.post("/api/auth/callback/test-persona", {
    form: { csrfToken, persona: "root" },
    maxRedirects: 0,
  });
  expect(rejected.headers().location).toContain("CredentialsSignin");
});
