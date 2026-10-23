import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "GitHub Copilot Usage Metrics",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-color-mode="light" data-light-theme="light" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
