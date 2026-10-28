import { adminRoute } from "../../../../admin/server";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => adminRoute(request, "grant-form");
