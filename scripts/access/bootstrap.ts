import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPortalSqlPool } from "../../portal/src/db/pool";
import { assertBootstrapEnvironment, BootstrapError, parseAccessBootstrapInput, runAccessBootstrap } from "../../portal/src/access/bootstrap";
import { readAccessSettings } from "../../portal/src/auth/settings";
import { isTestAuthEnabled } from "../../portal/src/auth/test-auth";

interface Arguments {
  inputPath: string;
  apply: boolean;
}

export function parseBootstrapArguments(args: readonly string[]): Arguments {
  let inputPath: string | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply" && !apply) {
      apply = true;
    } else if (arg === "--input" && inputPath === undefined && args[index + 1] && !args[index + 1]!.startsWith("--")) {
      inputPath = args[index + 1];
      index += 1;
    } else {
      throw new BootstrapError("invalid_input");
    }
  }
  if (!inputPath) throw new BootstrapError("invalid_input");
  return { inputPath, apply };
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function main(args: readonly string[]): Promise<void> {
  const correlationId = randomUUID();
  let pool: Awaited<ReturnType<typeof getPortalSqlPool>> | undefined;
  try {
    if (isTestAuthEnabled()) throw new BootstrapError("configuration_mismatch");
    const parsedArgs = parseBootstrapArguments(args);
    const inputPath = await realpath(path.resolve(parsedArgs.inputPath));
    if (isWithin(process.cwd(), inputPath)) throw new BootstrapError("invalid_input");
    const raw = await readFile(inputPath, "utf8");
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new BootstrapError("invalid_input");
    }
    const config = parseAccessBootstrapInput(input);
    assertBootstrapEnvironment(config, process.env);
    const settings = readAccessSettings();
    pool = await getPortalSqlPool();
    const result = await runAccessBootstrap(pool, config, {
      apply: parsedArgs.apply,
      correlationId,
      settings,
    });
    process.stdout.write(`${JSON.stringify({ event: "access.bootstrap", ...result })}\n`);
  } catch (error) {
    const code = error instanceof BootstrapError ? error.code : "transaction_failed";
    process.stderr.write(`${JSON.stringify({ event: "access.bootstrap.failed", code, correlationId })}\n`);
    process.exitCode = 1;
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {
        process.stderr.write(`${JSON.stringify({ event: "access.bootstrap.failed", code: "pool_close_failed", correlationId })}\n`);
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main(process.argv.slice(2));
}
