import path from "node:path";
import type { NextConfig } from "next";

// Dependencies are hoisted to the repository root by the npm workspace, so tracing and
// Turbopack must resolve from there to reach packages imported by portal/upstream.
const repositoryRoot = path.resolve(import.meta.dirname, "..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repositoryRoot,
  turbopack: { root: repositoryRoot },
  poweredByHeader: false,
  // Playwright drives `next dev` on 127.0.0.1; dev-only, ignored by production builds.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
