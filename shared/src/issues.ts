// Admin issues inbox and day-replacement guard (issue #44 items 9, 10). Backed by portal.ValidationIssue (ingestion writes
// issues) and portal.IssueAction (portal appends the admin's chosen action). A chosen action only marks the day for
// reprocessing; the ingestion Function does the work. Out of scope: comments, assignments, custom rules, alerts (#37).

import type { ApiResponse, PageRequest, PagedResponse } from "./api";
import type { AuditAction } from "./audit";
import type { IsoDate, IsoDateTime } from "./rows";

export const ISSUE_TYPES = ["duplicate_file", "smaller_day"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const ISSUE_STATUSES = ["open", "resolved", "dismissed"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_ACTIONS = {
  duplicate_file: ["retry", "accept_last", "accept_first", "reject"],
  smaller_day: ["force", "discard"],
} as const satisfies Record<IssueType, readonly string[]>;

export type IssueAction = (typeof ISSUE_ACTIONS)[IssueType][number];

// Actions that end the issue without reprocessing.
export const DISMISSING_ACTIONS: readonly IssueAction[] = ["reject", "discard"];

export interface InboxIssue {
  issueId: number;
  type: IssueType;
  status: IssueStatus;
  errorCode: string;
  reportDay: IsoDate | null;
  fileName: string | null;
  createdAt: IsoDateTime;
  availableActions: readonly IssueAction[];
}

export interface IssueListRequest extends PageRequest {
  status?: IssueStatus;
  type?: IssueType;
}
export type IssueListResponse = PagedResponse<InboxIssue>;

// For the banner: admin only, one number.
export type OpenIssueCountResponse = ApiResponse<{ openCount: number }>;

export interface IssueActionRequest {
  issueId: number;
  action: string;
  confirm: boolean;
}
export type IssueActionErrorCode = "forbidden" | "invalid_action" | "confirmation_required" | "not_found";
export type IssueActionResponse = ApiResponse<{ issueId: number; action: IssueAction; status: IssueStatus; reprocessRequested: boolean; audit: AuditAction }>;

export type IssueActionValidation = { ok: true } | { ok: false; code: IssueActionErrorCode };

export function validateIssueActionRequest(req: IssueActionRequest, type: IssueType, isAdmin: boolean): IssueActionValidation {
  if (!isAdmin) return { ok: false, code: "forbidden" };
  if (!(ISSUE_ACTIONS[type] as readonly string[]).includes(req.action)) return { ok: false, code: "invalid_action" };
  if (req.confirm !== true) return { ok: false, code: "confirmation_required" };
  return { ok: true };
}

export interface IssueStatusInput {
  lastAction: IssueAction | null;
  handledAt: string | null;
}

export function deriveIssueStatus(i: IssueStatusInput): IssueStatus {
  if (i.lastAction === null) return "open";
  if (DISMISSING_ACTIONS.includes(i.lastAction)) return "dismissed";
  return i.handledAt === null ? "open" : "resolved";
}

export interface DayReplacementInput {
  storedRows: number;
  incomingRows: number;
  adminForce: boolean;
}

export type DayReplacementDecision =
  | { decision: "allow"; audit?: Extract<AuditAction, "day.replace_forced"> }
  | { decision: "quarantine"; issueCode: "smaller_day_blocked" };

// §6.2 step 9: a day replaced by less data is blocked by default; only an admin force flag lets it through, and that is audited.
export function evaluateDayReplacement(i: DayReplacementInput): DayReplacementDecision {
  const valid = Number.isInteger(i.incomingRows) && i.incomingRows >= 0 && Number.isInteger(i.storedRows) && i.storedRows >= 0;
  if (valid && i.incomingRows >= i.storedRows) return { decision: "allow" };
  if (valid && i.adminForce) return { decision: "allow", audit: "day.replace_forced" };
  return { decision: "quarantine", issueCode: "smaller_day_blocked" };
}
