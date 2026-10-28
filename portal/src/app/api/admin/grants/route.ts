import { adminRoute } from "../../../../admin/server";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => adminRoute(request, "grants");
export const POST = (request: Request) => adminRoute(request, "grants");
export const DELETE = (request: Request) => adminRoute(request, "grants");
