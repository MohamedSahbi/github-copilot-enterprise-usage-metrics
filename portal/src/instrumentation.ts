import { assertTestAuthAllowed } from "@/auth/test-auth";

export function register(): void {
  assertTestAuthAllowed();
}
