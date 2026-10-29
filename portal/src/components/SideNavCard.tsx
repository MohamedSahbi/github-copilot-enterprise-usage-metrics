"use client";

import Link from "next/link";
import { NavList } from "@primer/react";
import {
  BriefcaseIcon, CodeIcon, CpuIcon, CreditCardIcon, DeviceDesktopIcon, GearIcon, GitCommitIcon,
  GraphIcon, HistoryIcon, HomeIcon, IssueOpenedIcon, LogIcon, OrganizationIcon, PeopleIcon, PulseIcon, RocketIcon,
  ShieldLockIcon, StackIcon, SyncIcon, TerminalIcon, VersionsIcon, type Icon,
} from "@primer/octicons-react";

// Icons are looked up by name because components cannot cross the server/client boundary as props.
const ICONS = {
  administration: GearIcon,
  overview: HomeIcon,
  "copilot-impact": GraphIcon,
  "executive-summary": BriefcaseIcon,
  users: PeopleIcon,
  languages: CodeIcon,
  clients: DeviceDesktopIcon,
  "client-versions": VersionsIcon,
  "copilot-adoption": RocketIcon,
  "model-usage": CpuIcon,
  "cli-adoption": TerminalIcon,
  "ai-adoption-phases": StackIcon,
  "budget-lookup": CreditCardIcon,
  access: ShieldLockIcon,
  hierarchy: OrganizationIcon,
  audit: LogIcon,
  "login-history": HistoryIcon,
  issues: IssueOpenedIcon,
  sync: SyncIcon,
  health: PulseIcon,
  upstream: GitCommitIcon,
} satisfies Record<string, Icon>;

export type SideNavIcon = keyof typeof ICONS;
export type SideNavItem = { href: string; label: string; icon?: SideNavIcon; current?: boolean; depth?: 1 | 2 };

// Carded Primer NavList, the same look as the upstream dashboard's side navigation.
export default function SideNavCard({ label, heading, items }: { label: string; heading?: string; items: SideNavItem[] }) {
  return (
    <div className="rounded-md border border-default bg-default p-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
      {heading && <p className="px-2 pb-1 pt-1 text-xs font-semibold text-muted">{heading}</p>}
      <NavList aria-label={label}>
        {items.map((item) => {
          const ItemIcon = item.icon ? ICONS[item.icon] : undefined;
          return (
            <NavList.Item
              key={item.href}
              as={Link}
              href={item.href}
              aria-current={item.current ? "page" : undefined}
              className={item.depth === 2 ? "pl-6" : undefined}
            >
              {ItemIcon && <NavList.LeadingVisual><ItemIcon /></NavList.LeadingVisual>}
              {item.label}
            </NavList.Item>
          );
        })}
      </NavList>
    </div>
  );
}
