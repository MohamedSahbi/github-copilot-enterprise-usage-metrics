import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { aiCreditCsv, invalidUsersDayLines, usersDayNdjson } from "./synthetic";

const dir = join(__dirname, "..", "..", "fixtures", "synthetic");
writeFileSync(join(dir, "users-1-day.ndjson"), usersDayNdjson());
writeFileSync(join(dir, "users-1-day.invalid.ndjson"), invalidUsersDayLines().join("\n") + "\n");
writeFileSync(join(dir, "ai-credit.csv"), aiCreditCsv());
