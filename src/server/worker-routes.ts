import { timingSafeEqual } from "node:crypto";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { WorkerService } from "../gen/struna/v1/worker_pb.js";
import type { Worker } from "../engine/worker.js";

const DEFAULT_BUDGET_MS = 10_000;
const MAX_BUDGET_MS = 300_000;
const DEFAULT_MAX_ITEMS = 100;
const MAX_ITEMS = 1_000;

function clamp(value: number, fallback: number, max: number): number {
  return value > 0 ? Math.min(value, max) : fallback;
}

function authorized(header: string | null, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Tick for schedulers (Cloud Scheduler, Cloud Tasks, cron). Without a token
 * the RPC is open, which suits a private network or Cloud Run IAM in front.
 */
export function workerRoutes(worker: Worker, tickToken: string | undefined) {
  return (router: ConnectRouter): void => {
    router.service(WorkerService, {
      async tick(req, context) {
        if (
          tickToken !== undefined &&
          !authorized(context.requestHeader.get("authorization"), tickToken)
        ) {
          throw new ConnectError("missing or invalid tick token", Code.Unauthenticated);
        }
        return worker.tick({
          budgetMs: clamp(req.budgetMs, DEFAULT_BUDGET_MS, MAX_BUDGET_MS),
          maxItems: clamp(req.maxItems, DEFAULT_MAX_ITEMS, MAX_ITEMS),
        });
      },
    });
  };
}
