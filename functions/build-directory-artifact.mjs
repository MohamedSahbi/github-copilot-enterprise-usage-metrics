import { build } from "esbuild";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const functionsRoot = path.dirname(fileURLToPath(import.meta.url));
const customArtifactRoot = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const manifest = JSON.parse(await readFile(path.join(functionsRoot, "package.json"), "utf8"));
const rootLock = JSON.parse(await readFile(path.join(functionsRoot, "..", "package-lock.json"), "utf8"));
const requiredRuntimeDependencies = ["@azure/functions", "@azure/identity", "mssql", "zod"];

for (const dependency of requiredRuntimeDependencies) {
  if (!manifest.dependencies?.[dependency]) throw new Error(`missing_runtime_dependency:${dependency}`);
}

function resolveLockedPackage(fromPackagePath, dependencyName) {
  let parent = fromPackagePath;
  while (true) {
    const candidate = parent ? `${parent}/node_modules/${dependencyName}` : `node_modules/${dependencyName}`;
    if (rootLock.packages[candidate]) return candidate;

    const nodeModulesIndex = parent.lastIndexOf("/node_modules/");
    if (nodeModulesIndex >= 0) parent = parent.slice(0, nodeModulesIndex);
    else if (parent.startsWith("node_modules/")) parent = "";
    else return undefined;
  }
}

const runtimeDependencies = Object.fromEntries(requiredRuntimeDependencies.map((name) => {
  const packagePath = resolveLockedPackage("", name);
  const version = packagePath && rootLock.packages[packagePath]?.version;
  if (!version) throw new Error(`missing_locked_runtime_dependency:${name}`);
  return [name, version];
}));
const runtimePackagePaths = new Set();
const pendingPackagePaths = requiredRuntimeDependencies.map((name) => resolveLockedPackage("", name));
while (pendingPackagePaths.length > 0) {
  const packagePath = pendingPackagePaths.pop();
  if (!packagePath || runtimePackagePaths.has(packagePath)) continue;

  const packageEntry = rootLock.packages[packagePath];
  if (!packageEntry || packageEntry.link || !packageEntry.version) {
    throw new Error(`invalid_locked_runtime_package:${packagePath}`);
  }
  if (Object.keys(packageEntry.peerDependencies ?? {}).length > 0) {
    throw new Error(`runtime_artifact_peer_dependency_requires_review:${packagePath}`);
  }

  runtimePackagePaths.add(packagePath);
  for (const dependencyName of Object.keys({
    ...packageEntry.dependencies,
    ...packageEntry.optionalDependencies,
  })) {
    const dependencyPath = resolveLockedPackage(packagePath, dependencyName);
    if (!dependencyPath) throw new Error(`missing_locked_transitive_dependency:${packagePath}:${dependencyName}`);
    pendingPackagePaths.push(dependencyPath);
  }
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
const artifactManifest = {
  name: `${manifest.name}-directory`,
  version: manifest.version,
  private: true,
  type: "module",
  main: "dist/function.js",
  engines: manifest.engines,
  dependencies: runtimeDependencies,
};
const lockedPackages = Object.fromEntries([...runtimePackagePaths].sort().map((packagePath) => {
  const packageEntry = { ...rootLock.packages[packagePath] };
  delete packageEntry.dev;
  delete packageEntry.devOptional;
  return [packagePath, packageEntry];
}));
await writeFile(path.join(artifactRoot, "package.json"), `${JSON.stringify(artifactManifest, null, 2)}\n`);
await writeFile(path.join(artifactRoot, "package-lock.json"), `${JSON.stringify({
  name: artifactManifest.name,
  version: artifactManifest.version,
  lockfileVersion: rootLock.lockfileVersion,
  requires: rootLock.requires,
  packages: {
    "": {
      name: artifactManifest.name,
      version: artifactManifest.version,
      engines: artifactManifest.engines,
      dependencies: artifactManifest.dependencies,
    },
    ...lockedPackages,
  },
}, null, 2)}\n`);
