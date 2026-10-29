import type { BreakdownKind, UsageFamily } from "../../../shared/src/rows";

// Curated SQL rows, keyed the way ingestion wrote them (see functions/src/metrics/day-parser.ts).
export interface CuratedDailyRow {
  organization_id: number;
  user_id: number;
  user_login: string | null;
  usage_day: string;
  interaction_count: number;
  code_generation_count: number;
  code_acceptance_count: number;
  loc_suggested_to_add: number;
  loc_suggested_to_delete: number;
  loc_added: number;
  loc_deleted: number;
  used_agent: boolean;
  used_chat: boolean;
  used_cli: boolean;
  used_cloud_agent: boolean;
  used_copilot_app: boolean;
  used_vscode_agent: boolean;
  used_code_review_active: boolean;
  used_code_review_passive: boolean;
  ai_credits_used: number | string;
  ai_adoption_phase_number: number | null;
  ai_adoption_phase: string | null;
  ai_adoption_phase_version: string | null;
  extra_json: string | null;
}

export interface CuratedBreakdownRow {
  organization_id: number;
  user_id: number;
  usage_day: string;
  breakdown_kind: BreakdownKind;
  key_1: string;
  key_2: string;
  interaction_count: number;
  code_generation_count: number;
  code_acceptance_count: number;
  loc_suggested_to_add: number;
  loc_suggested_to_delete: number;
  loc_added: number;
  loc_deleted: number;
  session_count: number | null;
  request_count: number | null;
  prompt_tokens: number | null;
  output_tokens: number | null;
  version_info: string | null;
  prompt_count: number | null;
  total_user_messages: number | null;
}

export interface CuratedFamilyRow {
  organization_id: number;
  user_id: number;
  usage_day: string;
  family: UsageFamily;
  item_name: string;
  interaction_count: number;
}
