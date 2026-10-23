import { readFileSync } from "node:fs";
import {
  isEligibleAuthor,
  normalizeTitle,
  parseBugReports,
  planIssues,
  prMarker,
  type BugReport,
  type ExistingIssue,
} from "./parse.ts";

interface PullRequestEvent {
  pull_request: { number: number; body: string | null; html_url: string; user: { login: string } };
}

const token = requireEnv("GITHUB_TOKEN");
const repository = requireEnv("GITHUB_REPOSITORY");
const owner = requireEnv("GITHUB_REPOSITORY_OWNER");
const event = JSON.parse(readFileSync(requireEnv("GITHUB_EVENT_PATH"), "utf8")) as PullRequestEvent;
const pr = event.pull_request;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function github<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${init?.method ?? "GET"} ${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

interface IssueSummary extends ExistingIssue {
  number: number;
  pull_request?: unknown;
}

async function listBugIssues(): Promise<IssueSummary[]> {
  const found: IssueSummary[] = [];
  for (let page = 1; page <= 10; page++) {
    const issues = await github<IssueSummary[]>(`/issues?labels=bug&state=all&per_page=100&page=${page}`);
    found.push(...issues.filter((issue) => !issue.pull_request));
    if (issues.length < 100) break;
  }
  return found;
}

/** Concurrent runs for different PRs can both create the same title; the lowest issue number wins. */
async function closeIfLaterDuplicate(created: { number: number }, title: string): Promise<void> {
  const key = normalizeTitle(title);
  const earlier = (await listBugIssues()).some(
    (issue) => normalizeTitle(issue.title) === key && issue.number < created.number,
  );
  if (!earlier) return;
  await github(`/issues/${created.number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed", state_reason: "not_planned" }),
  });
  console.log(`Closed #${created.number} as a duplicate of an earlier issue`);
}

function issueBody(report: BugReport): string {
  return [
    `Recorded from [PR #${pr.number}](${pr.html_url}) section "Out-of-scope bugs found".`,
    "",
    `**Where:** ${report.where}`,
    `**Severity:** ${report.severity}`,
    "",
    "**Reproduction**",
    "",
    report.steps,
    "",
    prMarker(pr.number),
  ].join("\n");
}

async function main(): Promise<void> {
  if (!isEligibleAuthor(pr.user.login, owner)) {
    console.log("PR author is neither the owner nor Copilot; nothing to do.");
    return;
  }
  const reports = parseBugReports(pr.body ?? "");
  if (reports.length === 0) {
    console.log("No out-of-scope bugs listed.");
    return;
  }
  const toCreate = planIssues(reports, await listBugIssues(), pr.number);
  console.log(`${toCreate.length} of ${reports.length} reported bugs will be created`);
  for (const report of toCreate) {
    const created = await github<{ html_url: string; number: number }>("/issues", {
      method: "POST",
      body: JSON.stringify({
        title: report.title,
        body: issueBody(report),
        labels: ["bug", "triage", "found-by-agent", `severity:${report.severity}`],
      }),
    });
    console.log(`Created ${created.html_url}`);
    await closeIfLaterDuplicate(created, report.title);
  }
}

await main();
