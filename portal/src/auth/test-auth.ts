/**
 * Test-only sign-in (D-41). Enabled solely by E2E_TEST_AUTH=1 and refused in production.
 * Nothing outside this module may read E2E_TEST_AUTH.
 */
import Credentials from "next-auth/providers/credentials";

export const TEST_PERSONAS = {
  admin: "Test Admin",
  manager: "Test Manager",
  member: "Test Member",
  "no-access": "Test No Access",
} as const;

export type TestPersonaId = keyof typeof TEST_PERSONAS;

type Env = Record<string, string | undefined>;

export function isTestAuthEnabled(env: Env = process.env): boolean {
  assertTestAuthAllowed(env);
  return env.E2E_TEST_AUTH === "1";
}

/** Production processes refuse to start with the flag set. */
export function assertTestAuthAllowed(env: Env = process.env): void {
  if (env.E2E_TEST_AUTH !== "1" || env.NODE_ENV !== "production") return;
  throw new Error("E2E_TEST_AUTH must not be enabled in a production deployment");
}

export function isTestPersonaId(value: unknown): value is TestPersonaId {
  return typeof value === "string" && Object.hasOwn(TEST_PERSONAS, value);
}

export function testPersonaObjectId(persona: TestPersonaId): string {
  const index = Object.keys(TEST_PERSONAS).indexOf(persona) + 1;
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export function testProviders() {
  if (!isTestAuthEnabled()) return [];
  return [Credentials({
    id: "test-persona",
    name: "Test persona",
    credentials: { persona: { label: "Persona", type: "text" } },
    authorize(credentials) {
      assertTestAuthAllowed();
      if (!isTestAuthEnabled() || !isTestPersonaId(credentials.persona)) return null;
      return {
        id: credentials.persona,
        name: TEST_PERSONAS[credentials.persona],
        tid: process.env.ENTRA_TENANT_ID,
        oid: testPersonaObjectId(credentials.persona),
      };
    },
  })];
}
