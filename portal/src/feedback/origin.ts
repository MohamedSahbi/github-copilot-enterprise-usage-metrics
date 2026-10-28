export function isFeedbackMutationOrigin(origin: string | null): boolean {
  const configured = process.env.AUTH_URL;
  if (!configured) throw new Error("AUTH_URL is required for Feedback mutations");
  const canonical = new URL(configured);
  if (!["http:", "https:"].includes(canonical.protocol) || canonical.username || canonical.password) {
    throw new Error("AUTH_URL must be an HTTP(S) URL without credentials");
  }
  if (!origin || origin === "null") return false;
  let caller: URL;
  try {
    caller = new URL(origin);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  return origin === caller.origin && caller.origin === canonical.origin;
}
