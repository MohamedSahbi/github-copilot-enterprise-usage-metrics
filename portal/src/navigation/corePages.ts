import { VIEW_MODES, type ViewMode } from "@upstream/types/navigation";
import type { PortalViewer } from "@/access/portalAccess";

export interface CorePage {
  slug: string;
  title: string;
  view: ViewMode;
  roles: PortalViewer["role"][];
  perUserOnly?: boolean;
}

export const CORE_PAGES: CorePage[] = [
  { slug: "overview", title: "Overview", view: VIEW_MODES.OVERVIEW, roles: ["admin", "executive", "manager", "member"] },
  { slug: "executive-summary", title: "Executive Summary", view: VIEW_MODES.EXECUTIVE_SUMMARY, roles: ["admin", "executive", "manager"] },
  { slug: "copilot-adoption", title: "Copilot Adoption", view: VIEW_MODES.COPILOT_ADOPTION, roles: ["admin", "executive", "manager", "member"] },
  { slug: "languages", title: "Languages", view: VIEW_MODES.LANGUAGES, roles: ["admin", "executive", "manager", "member"] },
  { slug: "model-usage", title: "Model Usage", view: VIEW_MODES.MODEL_DETAILS, roles: ["admin", "executive", "manager", "member"] },
  { slug: "cli-adoption", title: "CLI Adoption", view: VIEW_MODES.CLI_ADOPTION, roles: ["admin", "executive", "manager", "member"] },
  { slug: "copilot-impact", title: "Copilot Impact", view: VIEW_MODES.COPILOT_IMPACT, roles: ["admin", "executive", "manager", "member"] },
  { slug: "clients", title: "Clients", view: VIEW_MODES.CLIENT_ANALYSIS, roles: ["admin", "executive", "manager"] },
  { slug: "client-versions", title: "Client Versions", view: VIEW_MODES.CLIENT_VERSIONS, roles: ["admin", "executive", "manager"] },
  { slug: "ai-adoption-phases", title: "AI Adoption Phases", view: VIEW_MODES.AI_ADOPTION_PHASES, roles: ["admin", "executive", "manager"] },
  { slug: "users", title: "Users", view: VIEW_MODES.USERS, roles: ["admin", "executive", "manager"], perUserOnly: true },
];

export function visibleCorePages(viewer: PortalViewer): CorePage[] {
  return CORE_PAGES.filter(
    (page) => page.roles.includes(viewer.role) && (!page.perUserOnly || viewer.perUserDetailEnabled),
  );
}

export function getCorePage(slug: string): CorePage | undefined {
  return CORE_PAGES.find((page) => page.slug === slug);
}
