import { cookies } from "next/headers";
import { isTestAuthEnabled, isTestPersonaId, TEST_SESSION_COOKIE } from "@/auth/test-auth";

export const dynamic = "force-dynamic";

const notFound = () => new Response(null, { status: 404 });

export async function POST(request: Request): Promise<Response> {
  if (!isTestAuthEnabled()) return notFound();
  const body: unknown = await request.json().catch(() => null);
  const persona = typeof body === "object" && body !== null ? (body as { persona?: unknown }).persona : undefined;
  if (!isTestPersonaId(persona)) return Response.json({ error: "unknown persona" }, { status: 400 });
  (await cookies()).set(TEST_SESSION_COOKIE, persona, { httpOnly: true, sameSite: "lax", path: "/" });
  return Response.json({ persona });
}

export async function DELETE(): Promise<Response> {
  if (!isTestAuthEnabled()) return notFound();
  (await cookies()).delete(TEST_SESSION_COOKIE);
  return new Response(null, { status: 204 });
}
