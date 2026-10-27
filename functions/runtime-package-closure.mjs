function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  return match?.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function satisfiesPeerRange(version, range, packagePath, peerName) {
  const versionParts = parseVersion(version);
  const rangeMatch = /^([~^])(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(range);
  if (!rangeMatch) {
    throw new Error(`unsupported_runtime_peer_range:${packagePath}:${peerName}:${range}`);
  }
  if (!versionParts) {
    throw new Error(`invalid_locked_runtime_peer_version:${packagePath}:${peerName}:${version}`);
  }

  const lower = rangeMatch.slice(2).map(Number);
  const operator = rangeMatch[1];
  const upper = [...lower];
  if (operator === "~") {
    upper[1] += 1;
    upper[2] = 0;
  } else if (lower[0] > 0) {
    upper[0] += 1;
    upper[1] = 0;
    upper[2] = 0;
  } else if (lower[1] > 0) {
    upper[1] += 1;
    upper[2] = 0;
  } else {
    upper[2] += 1;
  }

  return compareVersions(versionParts, lower) >= 0 && compareVersions(versionParts, upper) < 0;
}

export function resolveRuntimePackageClosure(requiredPackagePaths, rootLock, resolveLockedPackage) {
  const runtimePackagePaths = new Set();
  const pendingPackagePaths = [...requiredPackagePaths];
  while (pendingPackagePaths.length > 0) {
    const packagePath = pendingPackagePaths.pop();
    if (!packagePath || runtimePackagePaths.has(packagePath)) continue;

    const packageEntry = rootLock.packages[packagePath];
    if (!packageEntry || packageEntry.link || !packageEntry.version) {
      throw new Error(`invalid_locked_runtime_package:${packagePath}`);
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

    for (const [peerName, peerRange] of Object.entries(packageEntry.peerDependencies ?? {})) {
      const peerPath = resolveLockedPackage(packagePath, peerName);
      const optional = packageEntry.peerDependenciesMeta?.[peerName]?.optional === true;
      if (!peerPath) {
        if (optional) continue;
        throw new Error(`missing_locked_runtime_peer:${packagePath}:${peerName}`);
      }

      const peerEntry = rootLock.packages[peerPath];
      if (!peerEntry || peerEntry.link || !peerEntry.version) {
        throw new Error(`invalid_locked_runtime_peer_package:${packagePath}:${peerName}`);
      }
      if (!satisfiesPeerRange(peerEntry.version, peerRange, packagePath, peerName)) {
        throw new Error(`unsatisfied_locked_runtime_peer:${packagePath}:${peerName}:${peerEntry.version}:${peerRange}`);
      }
      pendingPackagePaths.push(peerPath);
    }
  }

  return runtimePackagePaths;
}
