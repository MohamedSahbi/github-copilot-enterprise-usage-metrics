import { adminRoute } from "../../../../../admin/server";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => adminRoute(request, "issue-action");
