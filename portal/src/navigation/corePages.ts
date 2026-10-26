import type { PortalViewer } from "../access/portalAccess";

export const CORE_PAGE_SLUGS = ["overview", "copilot-impact"] as const;
export type CorePageSlug = typeof CORE_PAGE_SLUGS[number];

export interface CorePage {
  slug: CorePageSlug;
  title: string;
  roles: PortalViewer["role"][];
  perUserOnly?: boolean;
}

export const CORE_PAGES: CorePage[] = [
  { slug: "overview", title: "Overview", roles: ["admin", "executive", "manager", "member"] },
  { slug: "copilot-impact", title: "Copilot Impact", roles: ["admin", "executive", "manager", "member"] },
];

export function visibleCorePages(viewer: PortalViewer): CorePage[] {
  return CORE_PAGES.filter(
    (page) => page.roles.includes(viewer.role) && (!page.perUserOnly || viewer.perUserDetailEnabled),
  );
}

export function getCorePage(slug: string): CorePage | undefined {
  return CORE_PAGES.find((page) => page.slug === slug);
}
