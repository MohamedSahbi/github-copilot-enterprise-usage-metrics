"use client";

import { useEffect, useRef, type ReactNode } from "react";

export default function AccessibleUpstreamCharts({
  children,
  pageTitle,
}: {
  children: ReactNode;
  pageTitle: string;
}) {
  const region = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = region.current;
    if (!root) return;

    const nameCharts = () => {
      root.querySelectorAll("canvas").forEach((canvas, index) => {
        const chartContainer = canvas.closest<HTMLElement>('[data-component="ChartContainer"]');
        const chartTitle = chartContainer?.querySelector("h2, h3, h4")?.textContent?.trim();
        canvas.setAttribute("aria-label", chartTitle || `${pageTitle} chart ${index + 1}`);
      });

      root.querySelectorAll<HTMLElement>(".overflow-x-auto").forEach((region, index) => {
        if (!region.hasAttribute("tabindex")) region.tabIndex = 0;
        if (!region.hasAttribute("role")) region.setAttribute("role", "region");
        if (!region.hasAttribute("aria-label")) {
          const heading = region.closest("section")?.querySelector("h2, h3, h4")?.textContent?.trim();
          region.setAttribute("aria-label", heading || `${pageTitle} scrollable content ${index + 1}`);
        }
      });
    };

    nameCharts();
    const observer = new MutationObserver(nameCharts);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [pageTitle]);

  return <div ref={region}>{children}</div>;
}
