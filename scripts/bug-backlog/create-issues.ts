import { readFileSync } from "node:fs";
import { isEligibleAuthor, normalizeTitle, parseBugReports, type BugReport } from "./parse.ts";

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

async function existingTitles(): Promise<Set<string>> {
  const titles = new Set<string>();
  for (let page = 1; page <= 10; page++) {
    const issues = await github<{ title: string; pull_request?: unknown }[]>(
      `/issues?labels=bug&state=all&per_page=100&page=${page}`,
    );
    for (const issue of issues) if (!issue.pull_request) titles.add(normalizeTitle(issue.title));
    if (issues.length < 100) break;
  }
  return titles;
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
  const known = await existingTitles();
  for (const report of reports) {
    const key = normalizeTitle(report.title);
    if (known.has(key)) {
      console.log(`Skipping duplicate: ${report.title}`);
      continue;
    }
    const created = await github<{ html_url: string }>("/issues", {
      method: "POST",
      body: JSON.stringify({
        title: report.title,
        body: issueBody(report),
        labels: ["bug", "triage", "found-by-agent", `severity:${report.severity}`],
      }),
    });
    known.add(key);
    console.log(`Created ${created.html_url}`);
  }
}

await main();
