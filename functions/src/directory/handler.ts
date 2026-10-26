import { syncDirectory, type DirectorySyncDependencies, type DirectorySyncInput } from "./sync.js";

export interface DirectoryInvocationContext {
  invocationId: string;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

// A real use-case callback compatible with a Functions v4 timer handler. Registration/cadence is a separate gate.
export function createDirectoryHandler(
  loadInput: () => Promise<DirectorySyncInput>,
  createDependencies: (context: DirectoryInvocationContext) => Promise<Omit<DirectorySyncDependencies, "logger">>,
): (timer: unknown, context: DirectoryInvocationContext) => Promise<void> {
  return async (_timer, context) => {
    try {
      const input = await loadInput();
      const dependencies = await createDependencies(context);
      const result = await syncDirectory({ ...input, correlationId: context.invocationId }, { ...dependencies, logger: {
        info: (event) => context.info(JSON.stringify(event)),
        warn: (event) => context.warn(JSON.stringify(event)),
        error: (event) => context.error(JSON.stringify(event)),
      } });
      if (result.status !== "published") throw new Error("directory_handler_failed");
    } catch {
      context.error(JSON.stringify({ event: "directory.failed", code: "directory_handler_failed", correlation_id: context.invocationId }));
      throw new Error("directory_handler_failed");
    }
  };
}
