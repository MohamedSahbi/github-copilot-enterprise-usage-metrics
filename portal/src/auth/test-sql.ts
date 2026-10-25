import { localConnectionString } from "../../../scripts/stack/config";
import { isTestAuthEnabled } from "./test-auth";

export function testSqlConnection(): string | null {
  return isTestAuthEnabled() ? localConnectionString(process.env) : null;
}
