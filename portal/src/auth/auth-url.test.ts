import { readFileSync } from "node:fs";
import { createActionURL, setEnvDefaults, type AuthConfig } from "@auth/core";
import { describe, expect, it } from "vitest";

describe("production Auth.js canonical URL", () => {
  it("does not trust an unconfigured production host", () => {
    const config: AuthConfig = { providers: [] };
    setEnvDefaults({ NODE_ENV: "production" }, config);
    expect(config.trustHost).toBe(false);
  });

  it.each([
    "https://app-example-dev.azurewebsites.net",
    "https://portal.example.com",
  ])("trusts %s without AUTH_TRUST_HOST and ignores forwarded origin", (url) => {
    const env = { NODE_ENV: "production", AUTH_URL: url };
    const config: AuthConfig = { providers: [], basePath: "/api/auth" };
    setEnvDefaults(env, config, true);
    expect(config.trustHost).toBe(true);
    const actionUrl = createActionURL("signin", "http", new Headers({
      host: "untrusted.example",
      "x-forwarded-host": "forwarded.example",
      "x-forwarded-proto": "http",
    }), env, config);
    expect(actionUrl.href).toBe(`${url}/api/auth/signin`);
  });

  it("wires the explicit canonical URL and leaves trustHost to Auth.js defaults", () => {
    const terraform = readFileSync("infra/terraform/stack/apps.tf", "utf8");
    const config = readFileSync("portal/src/auth/config.ts", "utf8");
    expect(terraform).toMatch(/AUTH_URL\s*=\s*coalesce\(var\.portal_public_url, "https:\/\/\$\{local\.portal_app_name\}\.azurewebsites\.net"\)/);
    expect(config).not.toMatch(/\btrustHost\s*:/);
  });
});
