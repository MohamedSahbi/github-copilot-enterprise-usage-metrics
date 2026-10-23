/**
 * Test-only sign-in (D-41). Enabled solely by E2E_TEST_AUTH=1 and refused in production.
 * Nothing outside this module may read E2E_TEST_AUTH.
 */
export const TEST_SESSION_COOKIE = "e2e_persona";

export const TEST_PERSONAS = {
  admin: "Test Admin",
  manager: "Test Manager",
  member: "Test Member",
  "no-access": "Test No Access",
} as const;

export type TestPersonaId = keyof typeof TEST_PERSONAS;

type Env = Record<string, string | undefined>;

export function isTestAuthEnabled(env: Env = process.env): boolean {
  return env.E2E_TEST_AUTH === "1";
}

/**
 * Production builds refuse to start with the flag set. A local end-to-end run needs a production
 * build, so it must also set E2E_LOCAL_BUILD=1; that is never honoured on Azure App Service.
 */
export function assertTestAuthAllowed(env: Env = process.env): void {
  if (!isTestAuthEnabled(env) || env.NODE_ENV !== "production") return;
  const isAppService = Boolean(env.WEBSITE_SITE_NAME);
  if (env.E2E_LOCAL_BUILD === "1" && !isAppService) return;
  throw new Error("E2E_TEST_AUTH must not be enabled in a production deployment");
}

export function isTestPersonaId(value: unknown): value is TestPersonaId {
  return typeof value === "string" && Object.hasOwn(TEST_PERSONAS, value);
}

export function resolveTestPersona(cookieValue: string | undefined, env: Env = process.env): TestPersonaId | null {
  if (!isTestAuthEnabled(env) || !isTestPersonaId(cookieValue)) return null;
  return cookieValue;
}

export function personaLabel(cookieValue: string | undefined, env: Env = process.env): string | null {
  const persona = resolveTestPersona(cookieValue, env);
  return persona ? TEST_PERSONAS[persona] : null;
}
