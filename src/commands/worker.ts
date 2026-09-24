import { Command, InvalidArgumentError } from "commander";
import { loadEnvFile, workerConfig } from "../config.js";
import { assertSchema, disconnectPrisma, prisma } from "../db/client.js";
import { DEFAULT_MAX_PAYLOAD_BYTES } from "../engine/payload.js";
import { Worker, runWorker } from "../engine/worker.js";

function parseMs(value: string): number {
  const ms = Number.parseInt(value, 10);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new InvalidArgumentError("must be a positive integer (milliseconds)");
  }
  return ms;
}

interface WorkerOptions {
  databaseUrl?: string;
  idle?: number;
}

/**
 * `struna worker`: the Tick RPC in a loop, without the HTTP server. Scale by
 * running more of them against the same database.
 */
export function workerCommand(): Command {
  return new Command("worker")
    .description("Execute queued work from the database until stopped")
    .option("--database-url <url>", "override DATABASE_URL")
    .option("--idle <ms>", "sleep between ticks while the queue is empty", parseMs)
    .action(async (options: WorkerOptions) => {
      loadEnvFile();
      const config = workerConfig({
        ...(options.databaseUrl === undefined
          ? {}
          : { databaseUrl: options.databaseUrl }),
        ...(options.idle === undefined ? {} : { idleMs: options.idle }),
      });

      const db = prisma(config.databaseUrl);
      await assertSchema(db);
      const worker = new Worker(db, {
        payloadPolicy: { redactKeys: config.redactKeys, maxBytes: DEFAULT_MAX_PAYLOAD_BYTES },
      });
      const stop = new AbortController();
      const shutdown = (signal: NodeJS.Signals): void => {
        if (stop.signal.aborted) return;
        process.stdout.write(`\n${signal} received, finishing the current tick…\n`);
        stop.abort();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);

      process.stdout.write(`struna worker ${worker.id} started\n`);
      await runWorker(worker, {
        signal: stop.signal,
        idleMs: config.idleMs,
        onError: (cause) => {
          process.stderr.write(`tick failed: ${cause instanceof Error ? cause.message : cause}\n`);
        },
      });
      await disconnectPrisma();
    });
}
