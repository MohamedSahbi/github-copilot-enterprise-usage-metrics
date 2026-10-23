export const MAX_ISSUES_PER_PR = 5;
export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface BugReport {
  title: string;
  severity: Severity;
  where: string;
  steps: string;
}

const SECTION_HEADING = /^##\s+Out-of-scope bugs found\s*$/im;

export function extractSection(body: string): string {
  const match = SECTION_HEADING.exec(body);
  if (!match) return "";
  const rest = body.slice(match.index + match[0].length);
  const next = /^##\s/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

/**
 * Items are bullet or plain lines in the form `title | severity | where | steps`.
 * Lines that do not match the form (including "none") are ignored; at most MAX_ISSUES_PER_PR are returned.
 */
export function parseBugReports(body: string): BugReport[] {
  const section = extractSection(body).replace(/<!--[\s\S]*?-->/g, "");
  const reports: BugReport[] = [];
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim();
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length < 4) continue;
    const [title, severity, where, ...steps] = parts;
    const normalizedSeverity = (severity ?? "").toLowerCase().replace(/^severity:/, "");
    const reproduction = steps.join(" | ").trim();
    if (!title || !where || !reproduction || !isSeverity(normalizedSeverity)) continue;
    reports.push({ title, severity: normalizedSeverity, where, steps: reproduction });
    if (reports.length === MAX_ISSUES_PER_PR) break;
  }
  return reports;
}

export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isEligibleAuthor(login: string, repositoryOwner: string): boolean {
  const normalized = login.toLowerCase();
  return normalized === repositoryOwner.toLowerCase() || normalized === "copilot";
}

/** Hidden marker written into every issue so the per-PR limit survives edits and reruns. */
export function prMarker(prNumber: number): string {
  return `<!-- bug-backlog-pr:${prNumber} -->`;
}

export interface ExistingIssue {
  title: string;
  body: string | null;
}

/** Reports to create now: not duplicates, and within what is left of the PR's allowance. */
export function planIssues(reports: BugReport[], existing: ExistingIssue[], prNumber: number): BugReport[] {
  const marker = prMarker(prNumber);
  const known = new Set(existing.map((issue) => normalizeTitle(issue.title)));
  const alreadyCreated = existing.filter((issue) => issue.body?.includes(marker)).length;
  let remaining = Math.max(0, MAX_ISSUES_PER_PR - alreadyCreated);
  const plan: BugReport[] = [];
  for (const report of reports) {
    if (remaining === 0) break;
    const key = normalizeTitle(report.title);
    if (known.has(key)) continue;
    known.add(key);
    plan.push(report);
    remaining--;
  }
  return plan;
}
