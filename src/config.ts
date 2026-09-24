import { parseRedactKeys } from "./engine/payload.js";

/**
 * Environment-backed configuration. `.env` is read with Node's built-in loader
 * so there is no dotenv dependency at runtime.
 */
export interface ServeConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  /** Run a worker loop inside the server, next to the Tick RPC. */
  readonly worker: boolean;
  /** When set, Tick requires `Authorization: Bearer <tickToken>`. */
  readonly tickToken?: string | undefined;
  /** Key fragments masked in the event log and the dashboard. */
  readonly redactKeys: readonly string[];
}

export interface WorkerConfig {
  readonly databaseUrl: string;
  /** Sleep between ticks while the queue is empty. */
  readonly idleMs: number;
  /** Key fragments masked in the event log. */
  readonly redactKeys: readonly string[];
}

export function loadEnvFile(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Missing or unreadable .env is fine — real environments set vars directly.
  }
}

function intFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${key} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** The Postgres from compose.yaml, for when DATABASE_URL is not set. */
export const DEFAULT_DATABASE_URL = "postgresql://struna:struna@localhost:5433/struna";

function databaseUrl(override: string | undefined): string {
  return override ?? process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL;
}

export function serveConfig(overrides: Partial<ServeConfig> = {}): ServeConfig {
  const tickToken = overrides.tickToken ?? process.env["STRUNA_TICK_TOKEN"];
  return {
    host: overrides.host ?? process.env["HOST"] ?? "127.0.0.1",
    port: overrides.port ?? intFromEnv("PORT", 8080),
    databaseUrl: databaseUrl(overrides.databaseUrl),
    worker: overrides.worker ?? false,
    tickToken: tickToken === "" ? undefined : tickToken,
    redactKeys: overrides.redactKeys ?? parseRedactKeys(process.env["STRUNA_REDACT_KEYS"]),
  };
}

export function workerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: databaseUrl(overrides.databaseUrl),
    idleMs: overrides.idleMs ?? intFromEnv("STRUNA_IDLE_MS", 1_000),
    redactKeys: overrides.redactKeys ?? parseRedactKeys(process.env["STRUNA_REDACT_KEYS"]),
  };
}
