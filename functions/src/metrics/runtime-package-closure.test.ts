import { describe, expect, it } from "vitest";
import { resolveRuntimePackageClosure } from "../../runtime-package-closure.mjs";

type LockPackage = {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  link?: boolean;
};

function resolveFromLock(packages: Record<string, LockPackage>, fromPackagePath: string, dependencyName: string): string | undefined {
  let parent = fromPackagePath;
  while (true) {
    const candidate = parent ? `${parent}/node_modules/${dependencyName}` : `node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;

    const nodeModulesIndex = parent.lastIndexOf("/node_modules/");
    if (nodeModulesIndex >= 0) parent = parent.slice(0, nodeModulesIndex);
    else if (parent.startsWith("node_modules/")) parent = "";
    else return undefined;
  }
}

function resolveClosure(packages: Record<string, LockPackage>): Set<string> {
  const rootLock = { packages };
  return resolveRuntimePackageClosure(
    ["node_modules/consumer"],
    rootLock,
    (from, name) => resolveFromLock(packages, from, name),
  );
}

describe("runtime package peer closure", () => {
  it("includes a compatible required peer in the closure", () => {
    const closure = resolveClosure({
      "node_modules/consumer": {
        version: "1.0.0",
        peerDependencies: { peer: "^1.2.0" },
      },
      "node_modules/peer": { version: "1.4.0" },
    });

    expect(closure).toEqual(new Set(["node_modules/consumer", "node_modules/peer"]));
  });

  it("rejects a missing required peer", () => {
    expect(() => resolveClosure({
      "node_modules/consumer": {
        version: "1.0.0",
        peerDependencies: { peer: "^1.2.0" },
      },
    })).toThrow("missing_locked_runtime_peer:node_modules/consumer:peer");
  });

  it("rejects a locked peer version outside its declared range", () => {
    expect(() => resolveClosure({
      "node_modules/consumer": {
        version: "1.0.0",
        peerDependencies: { peer: "^1.2.0" },
      },
      "node_modules/peer": { version: "2.0.0" },
    })).toThrow("unsatisfied_locked_runtime_peer:node_modules/consumer:peer:2.0.0:^1.2.0");
  });

  it("rejects peer range syntax outside the supported exact caret and tilde forms", () => {
    expect(() => resolveClosure({
      "node_modules/consumer": {
        version: "1.0.0",
        peerDependencies: { peer: ">=1.2.0" },
      },
      "node_modules/peer": { version: "1.4.0" },
    })).toThrow("unsupported_runtime_peer_range:node_modules/consumer:peer:>=1.2.0");
  });

  it("skips an absent optional peer", () => {
    expect(resolveClosure({
      "node_modules/consumer": {
        version: "1.0.0",
        peerDependencies: { peer: "^1.2.0" },
        peerDependenciesMeta: { peer: { optional: true } },
      },
    })).toEqual(new Set(["node_modules/consumer"]));
  });
});
