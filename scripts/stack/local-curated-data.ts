import { seedTestOnlyCuratedData } from "./test-only-curated-seed";

// Single local-stack switch point: use the real metrics day loader here once Phase 2 issue #73 lands.
export async function loadLocalCuratedData(connectionString: string) {
  return seedTestOnlyCuratedData(connectionString);
}
