import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { ServeConfig } from "../config.js";
import { assertSchema, prisma, disconnectPrisma } from "../db/client.js";
import { ProcessEngine } from "../engine/process-engine.js";
import { DEFAULT_MAX_PAYLOAD_BYTES, parseRedactKeys } from "../engine/payload.js";
import { Worker, runWorker } from "../engine/worker.js";
import { processRoutes } from "./routes.js";
import { handleUi } from "./ui.js";
import { workerRoutes } from "./worker-routes.js";

type Fallback = NonNullable<
  Parameters<typeof connectNodeAdapter>[0]["fallback"]
>;

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * One HTTP/1.1 listener serves both the Connect API and the htmx dashboard: Connect's protocol works over HTTP/1.1, and sharing a port keeps the
 * browser-facing routes same-origin. (Plain gRPC clients need HTTP/2 and are
 * not served here.)
 *
 * The server only queues work. It is executed by Tick calls, by the embedded
 * worker loop when `config.worker` is set, or by `struna worker` processes on
 * the same database.
 */
export async function startServer(
  config: Omit<ServeConfig, "redactKeys"> & { readonly redactKeys?: readonly string[] },
): Promise<RunningServer> {
  const db = prisma(config.databaseUrl);
  await assertSchema(db);
  const payloadPolicy = {
    redactKeys: config.redactKeys ?? parseRedactKeys(undefined),
    maxBytes: DEFAULT_MAX_PAYLOAD_BYTES,
  };
  const engine = new ProcessEngine(db, { payloadPolicy });
  const worker = new Worker(db, { payloadPolicy });

  const handler = connectNodeAdapter({
    routes: (router) => {
      processRoutes(engine)(router);
      workerRoutes(worker, config.tickToken)(router);
    },
    // Anything that is not an RPC path is the htmx dashboard. connect-node
    // types `fallback` for both HTTP/1.1 and HTTP/2; this listener is created
    // by `http.createServer` below, so the HTTP/1.1 half is the only one that
    // can reach here.
    fallback: ((req: IncomingMessage, res: ServerResponse) => {
      void handleUi({ engine, req, res, worker: config.worker })
        .then((handled) => {
          if (handled) return;
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found\n");
        })
        .catch((cause: unknown) => {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "text/plain" });
          }
          res.end(cause instanceof Error ? cause.message : "internal error");
        });
    }) as Fallback,
  });

  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;

  const stopWorker = new AbortController();
  const workerLoop = config.worker
    ? runWorker(worker, {
        signal: stopWorker.signal,
        onError: (cause) => {
          process.stderr.write(`worker: ${cause instanceof Error ? cause.message : cause}\n`);
        },
      })
    : Promise.resolve();

  return {
    url: `http://${config.host}:${port}`,
    port,
    async close() {
      stopWorker.abort();
      await workerLoop;
      // Open SSE and WatchInstance streams would otherwise hold close() open.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await disconnectPrisma();
    },
  };
}
