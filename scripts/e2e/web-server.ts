export function e2eWebServerCommand(port: number, bundler?: string): string {
  if (bundler !== undefined && bundler !== "turbopack" && bundler !== "webpack") {
    throw new Error("E2E_DEV_BUNDLER must be either 'turbopack' or 'webpack'");
  }
  const script = bundler === "webpack" ? "dev:e2e" : "dev";
  return `npm run ${script} -w portal -- --port ${port}`;
}
