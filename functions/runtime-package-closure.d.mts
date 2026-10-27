export function resolveRuntimePackageClosure(
  requiredPackagePaths: Array<string | undefined>,
  rootLock: { packages: Record<string, Record<string, unknown>> },
  resolveLockedPackage: (fromPackagePath: string, dependencyName: string) => string | undefined,
): Set<string>;
