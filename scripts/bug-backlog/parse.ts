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
    if (!title || !where || !isSeverity(normalizedSeverity)) continue;
    reports.push({ title, severity: normalizedSeverity, where, steps: steps.join(" | ") });
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
