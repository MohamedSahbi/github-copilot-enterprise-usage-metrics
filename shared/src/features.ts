// Feature taxonomy, mirroring upstream src/domain/featureCategories.ts (the oracle). A contract test compares both.

export type ChatModeBucket = "ask" | "agent" | "edit" | "inline" | "plan";

export interface FeatureClass {
  isChat: boolean;
  isAgent: boolean;
  isCli: boolean;
  chatModeBucket?: ChatModeBucket;
}

const c = (chatModeBucket?: ChatModeBucket, o: Partial<FeatureClass> = {}): FeatureClass => ({
  isChat: false,
  isAgent: false,
  isCli: false,
  ...(chatModeBucket ? { chatModeBucket } : {}),
  ...o,
});

export const FEATURE_TAXONOMY: Readonly<Record<string, FeatureClass>> = {
  chat_panel_edit_mode: c("edit", { isChat: true }),
  chat_panel_ask_mode: c("ask", { isChat: true }),
  chat_panel_agent_mode: c("agent", { isChat: true, isAgent: true }),
  chat_panel_custom_mode: c(),
  chat_panel_plan_mode: c("plan", { isChat: true }),
  code_completion: c(),
  chat_panel_unknown_mode: c(undefined, { isChat: true }),
  chat_inline: c("inline", { isChat: true }),
  agent_edit: c(undefined, { isAgent: true }),
  copilot_cli: c(undefined, { isCli: true }),
  copilot_app: c(),
  vscode_agent: c(),
};

export const isKnownFeature = (feature: string): boolean => feature in FEATURE_TAXONOMY;
export const isChatFeature = (f: string): boolean => FEATURE_TAXONOMY[f]?.isChat ?? false;
export const isAgentFeature = (f: string): boolean => FEATURE_TAXONOMY[f]?.isAgent ?? false;
export const isCodeCompletionFeature = (f: string): boolean => f === "code_completion";
