import path from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

// Dependencies are hoisted to the repository root by the npm workspace, so tracing and
// Turbopack must resolve from there to reach packages imported by portal/upstream.
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const upstreamCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: path.join(import.meta.dirname, "upstream"), encoding: "utf8",
}).trim();
if (!/^[0-9a-f]{40}$/.test(upstreamCommit)) throw new Error("Cannot identify the pinned upstream commit");
const release: { version: string } = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

const nextConfig: NextConfig = {
  env: {
    PORTAL_RELEASE_VERSION: release.version,
    PORTAL_UPSTREAM_COMMIT: upstreamCommit,
  },
  output: "standalone",
  outputFileTracingRoot: repositoryRoot,
  turbopack: { root: repositoryRoot },
  poweredByHeader: false,
  // Playwright drives `next dev` on 127.0.0.1; dev-only, ignored by production builds.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
