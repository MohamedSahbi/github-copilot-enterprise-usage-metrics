import { renderCorePage } from "../corePage";

export const dynamic = "force-dynamic";

export default async function CorePage({
  params,
  searchParams,
}: {
  params: Promise<{ page: string }>;
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  return renderCorePage((await params).page, searchParams);
}
