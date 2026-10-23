"use client";

import type { ReactNode } from "react";
import { BaseStyles, ThemeProvider } from "@primer/react";

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider colorMode="day">
      <BaseStyles>{children}</BaseStyles>
    </ThemeProvider>
  );
}
