import { openPool } from "../scripts/integration/db";
import { seedAuth } from "../scripts/integration/auth-seed";

export default async function setup() {
  if (process.env.BASE_URL || process.env.E2E_SQL_OUTAGE) return;
  const pool = await openPool();
  try { await seedAuth(pool); } finally { await pool.close(); }
}
