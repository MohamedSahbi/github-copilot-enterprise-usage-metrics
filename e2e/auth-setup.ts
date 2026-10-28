import { openPool } from "../scripts/integration/db";
import { seedAuth } from "../scripts/integration/auth-seed";
import { E2E_LOCAL_HOST, getLocalE2EPort, waitForLocalSignInRoute } from "../scripts/e2e/route-readiness";

export default async function setup() {
  if (process.env.BASE_URL || process.env.E2E_SQL_OUTAGE) return;
  const pool = await openPool();
  try { await seedAuth(pool); } finally { await pool.close(); }
  await waitForLocalSignInRoute(E2E_LOCAL_HOST, getLocalE2EPort(process.env.E2E_PORT ?? "3100"));
}
