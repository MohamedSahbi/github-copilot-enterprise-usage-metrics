import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getAccess } from "../../authz/server";
import { canAccess } from "../../authz/access";
import { getPortalSqlPool } from "../../db/pool";
import { feedbackEnabled } from "../../feedback/access";
import { feedbackFailure } from "../../feedback/api";
import { listFeedback } from "../../feedback/sql-feedback";
import VoteButton from "../../feedback/VoteButton";
import { parsePage } from "../../usage/api";

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string }>;
}) {
  const correlationId = randomUUID();
  const access = await getAccess(correlationId);
  if (access.state === "signed-out") redirect("/sign-in");
  if (access.state === "unavailable") redirect("/service-unavailable");
  if (access.state !== "authorized" || !canAccess(access, "feedback")) redirect("/no-access");
  if (!feedbackEnabled()) notFound();

  const params = await searchParams;
  const paging = parsePage(new URLSearchParams({ page: params.page ?? "1", pageSize: "25" }));
  const status = z.enum(["open", "planned", "done", "declined"]).optional().safeParse(params.status || undefined);
  if (!paging.ok || !status.success) notFound();

  let result: Awaited<ReturnType<typeof listFeedback>>;
  try {
    result = await listFeedback(await getPortalSqlPool(), access, { ...paging.page, status: status.data });
  } catch (error) {
    feedbackFailure(correlationId, error);
    return (
      <main className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="text-2xl font-semibold">Feedback unavailable</h1>
        <p>Feedback could not be loaded. Please try again later.</p>
        <Link href="/">Return to Overview</Link>
      </main>
    );
  }
  const pageHref = (page: number) => `/feedback?${new URLSearchParams({
    page: String(page), ...(status.data ? { status: status.data } : {}),
  })}`;

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-10">
      <Link href="/">Return to Overview</Link>
      <header>
        <h1 className="text-2xl font-semibold">Feedback</h1>
        <p className="mt-2 text-muted">Vote on feedback to help us prioritise.</p>
      </header>
      <p role="status" className="rounded border border-default p-4 text-sm">
        New submissions, screenshots, comments and work-item URL editing are not yet available in this release.
      </p>
      <form className="flex items-center gap-3">
        <label htmlFor="feedback-status">Status</label>
        <select id="feedback-status" name="status" defaultValue={status.data ?? ""}
          className="rounded border border-default p-2">
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="planned">Planned</option>
          <option value="done">Done</option>
          <option value="declined">Declined</option>
        </select>
        <button type="submit" className="rounded border border-default px-3 py-2">Filter</button>
      </form>
      {result.rows.length === 0 && <p>No feedback yet.</p>}
      <ul className="space-y-4">
        {result.rows.map((item) => (
          <li key={item.itemId}>
            <article aria-labelledby={`feedback-${item.itemId}`} className="space-y-3 rounded border border-default p-5">
              <h2 id={`feedback-${item.itemId}`} className="text-lg font-semibold">{item.title}</h2>
              <p className="whitespace-pre-wrap">{item.body}</p>
              <p className="text-sm text-muted">
                Status: {item.status} | {item.commentCount} comments | Submitted {item.createdAt.slice(0, 10)}
              </p>
              <VoteButton itemId={item.itemId} votes={item.votes} />
            </article>
          </li>
        ))}
      </ul>
      <nav aria-label="Feedback pagination" className="flex items-center gap-4">
        {paging.page.page > 1 && <Link href={pageHref(paging.page.page - 1)}>Previous</Link>}
        <span>Page {paging.page.page} | {result.totalItems} items</span>
        {paging.page.page * paging.page.pageSize < result.totalItems &&
          <Link href={pageHref(paging.page.page + 1)}>Next</Link>}
      </nav>
    </main>
  );
}
