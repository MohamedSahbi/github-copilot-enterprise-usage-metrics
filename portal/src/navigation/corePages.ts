import { VIEW_MODES, type ViewMode } from "../../upstream/src/types/navigation";
import type { PortalViewer } from "../access/portalAccess";

export const CORE_PAGE_SLUGS = ["overview", "copilot-impact"] as const;
export type CorePageSlug = typeof CORE_PAGE_SLUGS[number];

export const UPSTREAM_PAGE_SLUGS = [
  "executive-summary",
  "users",
  "languages",
  "clients",
  "client-versions",
  "copilot-adoption",
  "model-usage",
  "cli-adoption",
  "ai-adoption-phases",
] as const;
export type UpstreamPageSlug = typeof UPSTREAM_PAGE_SLUGS[number];

const ALL_ROLES: PortalViewer["role"][] = ["admin", "executive", "manager", "member"];

export interface CorePage {
  slug: CorePageSlug | UpstreamPageSlug;
  title: string;
  roles: PortalViewer["role"][];
  view: ViewMode;
  perUserOnly?: boolean;
  /** Shown only when the deployment turns on the upstream views (MODULE_UPSTREAM_VIEWS). */
  upstreamOnly?: boolean;
}

export const CORE_PAGES: CorePage[] = [
  { slug: "overview", title: "Overview", roles: ALL_ROLES, view: VIEW_MODES.OVERVIEW },
  { slug: "executive-summary", title: "Executive Summary", roles: ALL_ROLES, view: VIEW_MODES.EXECUTIVE_SUMMARY, upstreamOnly: true },
  { slug: "users", title: "Users", roles: ALL_ROLES, view: VIEW_MODES.USERS, perUserOnly: true, upstreamOnly: true },
  { slug: "languages", title: "Languages", roles: ALL_ROLES, view: VIEW_MODES.LANGUAGES, upstreamOnly: true },
  { slug: "clients", title: "Clients", roles: ALL_ROLES, view: VIEW_MODES.CLIENT_ANALYSIS, upstreamOnly: true },
  { slug: "client-versions", title: "Client Versions", roles: ALL_ROLES, view: VIEW_MODES.CLIENT_VERSIONS, upstreamOnly: true },
  { slug: "copilot-impact", title: "Copilot Impact", roles: ALL_ROLES, view: VIEW_MODES.COPILOT_IMPACT },
  { slug: "copilot-adoption", title: "Copilot Adoption", roles: ALL_ROLES, view: VIEW_MODES.COPILOT_ADOPTION, upstreamOnly: true },
  { slug: "model-usage", title: "Model Usage", roles: ALL_ROLES, view: VIEW_MODES.MODEL_DETAILS, upstreamOnly: true },
  { slug: "cli-adoption", title: "CLI Adoption", roles: ALL_ROLES, view: VIEW_MODES.CLI_ADOPTION, upstreamOnly: true },
  { slug: "ai-adoption-phases", title: "AI Adoption Phases", roles: ALL_ROLES, view: VIEW_MODES.AI_ADOPTION_PHASES, upstreamOnly: true },
];

export function upstreamViewsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.MODULE_UPSTREAM_VIEWS;
  if (flag === undefined || flag === "false") return false;
  if (flag === "true") return true;
  throw new Error("MODULE_UPSTREAM_VIEWS must be true or false");
}

export function visibleCorePages(
  viewer: PortalViewer,
  env: Record<string, string | undefined> = process.env,
): CorePage[] {
  const upstream = upstreamViewsEnabled(env);
  return CORE_PAGES.filter(
    (page) => page.roles.includes(viewer.role)
      && (!page.perUserOnly || viewer.perUserDetailEnabled)
      && (!page.upstreamOnly || upstream),
  );
}

export function getCorePage(
  slug: string,
  env: Record<string, string | undefined> = process.env,
): CorePage | undefined {
  const page = CORE_PAGES.find((candidate) => candidate.slug === slug);
  return page && (!page.upstreamOnly || upstreamViewsEnabled(env)) ? page : undefined;
}
