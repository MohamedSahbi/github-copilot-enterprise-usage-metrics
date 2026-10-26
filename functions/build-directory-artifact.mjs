import { build } from "esbuild";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const functionsRoot = path.dirname(fileURLToPath(import.meta.url));
const customArtifactRoot = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const manifest = JSON.parse(await readFile(path.join(functionsRoot, "package.json"), "utf8"));
const requiredRuntimeDependencies = ["@azure/functions", "@azure/identity", "mssql", "zod"];

for (const dependency of requiredRuntimeDependencies) {
  if (!manifest.dependencies?.[dependency]) throw new Error(`missing_runtime_dependency:${dependency}`);
}

let artifactRoot;
if (customArtifactRoot) {
  const customRootStat = await lstat(customArtifactRoot);
  const canonicalTempRoot = await realpath(os.tmpdir());
  const canonicalArtifactRoot = await realpath(customArtifactRoot);
  const relativePath = path.relative(canonicalTempRoot, canonicalArtifactRoot);
  if (customRootStat.isSymbolicLink() || !customRootStat.isDirectory() ||
      relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath) ||
      !path.basename(customArtifactRoot).startsWith("directory-artifact-") ||
      (await readdir(canonicalArtifactRoot)).length !== 0) {
    throw new Error("custom_artifact_path_must_be_a_directory_artifact_temp_path");
  }
  artifactRoot = canonicalArtifactRoot;
  await mkdir(path.join(artifactRoot, "dist"));
} else {
  const canonicalFunctionsRoot = await realpath(functionsRoot);
  const distRoot = path.join(functionsRoot, "dist");
  await mkdir(distRoot, { recursive: true });
  const canonicalDistRoot = await realpath(distRoot);
  const relativeDistRoot = path.relative(canonicalFunctionsRoot, canonicalDistRoot);
  if (relativeDistRoot === "" || relativeDistRoot.startsWith("..") ||
      path.isAbsolute(relativeDistRoot)) {
    throw new Error("default_artifact_path_must_remain_inside_functions_directory");
  }

  artifactRoot = path.join(canonicalDistRoot, "artifact");
  try {
    const artifactStat = await lstat(artifactRoot);
    if (artifactStat.isSymbolicLink()) throw new Error("default_artifact_path_must_not_be_a_symlink");
    await rm(artifactRoot, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(artifactRoot);
}

if (customArtifactRoot === undefined) await mkdir(path.join(artifactRoot, "dist"));
await build({
  absWorkingDir: functionsRoot,
  entryPoints: ["src/directory/function.ts"],
  outfile: path.join(artifactRoot, "dist/function.js"),
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node22",
  format: "esm",
  legalComments: "none",
  sourcemap: false,
  write: true,
  logLevel: "silent",
});
await cp(path.join(functionsRoot, "host.json"), path.join(artifactRoot, "host.json"));
await writeFile(path.join(artifactRoot, "package.json"), `${JSON.stringify({
  name: `${manifest.name}-directory`,
  version: manifest.version,
  private: true,
  type: "module",
  main: "dist/function.js",
  engines: manifest.engines,
  dependencies: Object.fromEntries(requiredRuntimeDependencies.map((name) => [name, manifest.dependencies[name]])),
}, null, 2)}\n`);
