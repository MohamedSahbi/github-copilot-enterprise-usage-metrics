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
};

export default nextConfig;
