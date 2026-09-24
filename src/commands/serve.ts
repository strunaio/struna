import { Command, InvalidArgumentError } from "commander";
import { loadEnvFile, serveConfig } from "../config.js";
import { startServer } from "../server/server.js";

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError("port must be an integer between 0 and 65535");
  }
  return port;
}

interface ServeOptions {
  port?: number;
  host?: string;
  databaseUrl?: string;
  worker?: boolean;
}

export function serveCommand(): Command {
  return new Command("serve")
    .description("Run the Connect RPC API and web UI")
    .option("-p, --port <port>", "port to listen on", parsePort)
    .option("-H, --host <host>", "address to bind")
    .option("--database-url <url>", "override DATABASE_URL")
    .option("--worker", "also execute queued work in this process")
    .action(async (options: ServeOptions) => {
      loadEnvFile();
      const config = serveConfig({
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.databaseUrl === undefined
          ? {}
          : { databaseUrl: options.databaseUrl }),
        worker: options.worker === true,
      });

      const server = await startServer(config);
      process.stdout.write(
        `struna listening on ${server.url}${config.worker ? " (with worker)" : ""}\n`,
      );

      let closing = false;
      const shutdown = (signal: NodeJS.Signals): void => {
        if (closing) return;
        closing = true;
        process.stdout.write(`\n${signal} received, draining…\n`);
        server
          .close()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
}
