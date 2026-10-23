export const dynamic = "force-dynamic";

// SQL reachability, ingestion age, and per-module health are added with the data layer (D-43, D-50).
export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
