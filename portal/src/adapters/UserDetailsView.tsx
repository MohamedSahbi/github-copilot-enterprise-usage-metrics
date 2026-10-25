"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { NavigationProvider, useNavigation } from "@upstream/state/NavigationContext";
import { VIEW_MODES } from "@upstream/types/navigation";
import type { UserDetailsViewModel } from "@upstream/read-models/userDetails";
import { UserDetailsView as UpstreamUserDetailsView } from "@upstream/components/features/user-details";
import AccessibleUpstreamCharts from "@/components/AccessibleUpstreamCharts";

function NavigationBridge({ scopeQuery }: { scopeQuery: string }) {
  const router = useRouter();
  const { currentView } = useNavigation();

  useEffect(() => {
    if (currentView === VIEW_MODES.USERS) router.push(`/users?${scopeQuery}`);
  }, [currentView, router, scopeQuery]);

  return null;
}

export default function UserDetailsView({
  model,
  scopeQuery,
}: {
  model: UserDetailsViewModel;
  scopeQuery: string;
}) {
  return (
    <AccessibleUpstreamCharts pageTitle="User Details">
      <NavigationProvider>
        <NavigationBridge scopeQuery={scopeQuery} />
        <UpstreamUserDetailsView model={model} />
      </NavigationProvider>
    </AccessibleUpstreamCharts>
  );
}
