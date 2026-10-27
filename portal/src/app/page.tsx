import { renderCorePage } from "./corePage";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  return renderCorePage("overview", searchParams);
}
