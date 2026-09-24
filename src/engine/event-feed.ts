import { setTimeout as sleep } from "node:timers/promises";
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../gen/prisma/client.js";

/** A recorded event, ordered by `seq` (its row id). */
export interface EngineEvent {
  readonly seq: bigint;
  readonly instanceId: string;
  readonly type: string;
  readonly elementId?: string | undefined;
  readonly payload: Prisma.JsonValue;
  readonly createdAt: Date;
}

const DEFAULT_POLL_MS = 250;
const BATCH = 200;

/**
 * How far back each poll re-reads. A bigserial id is taken at insert but
 * becomes visible at commit, so a lower id can appear after a higher one has
 * been read — the cursor alone would step past it for good. Commits are
 * milliseconds apart; the window also absorbs clock skew between workers,
 * which stamp `createdAt`.
 */
const LOOK_BACK_MS = 5_000;

/**
 * Tails the `process_events` table. Events are written by whichever process
 * ran the instance — an embedded worker or a separate `struna worker` — so the
 * log is the only place every subscriber can see them. Each subscription
 * keeps its own cursor on the row id, plus the ids it has already delivered
 * from the look-back window so a late row is yielded once and only once.
 */
export class EventFeed {
  constructor(
    private readonly db: PrismaClient,
    private readonly pollMs = DEFAULT_POLL_MS,
  ) {}

  /** Sequence of the newest recorded event, or 0 if there are none. */
  async latestSeq(): Promise<bigint> {
    const row = await this.db.processEvent.findFirst({
      orderBy: { id: "desc" },
      select: { id: true },
    });
    return row?.id ?? 0n;
  }

  /**
   * Yield events with `seq > after`, optionally for one instance, until
   * `signal` aborts. Events are yielded in id order, except that a row which
   * commits late is yielded when it shows up.
   */
  async *subscribe(options: {
    signal: AbortSignal;
    after?: bigint;
    instanceId?: string;
  }): AsyncGenerator<EngineEvent> {
    const { signal, instanceId } = options;
    const scope = instanceId === undefined ? {} : { instanceId };
    const floor = options.after ?? 0n;
    let cursor = floor;
    /** Delivered ids at or below the cursor that are still inside the window. */
    const recent = new Map<bigint, number>();

    while (!signal.aborted) {
      const since = new Date(Date.now() - LOOK_BACK_MS);
      const [late, fresh] = await Promise.all([
        this.db.processEvent.findMany({
          where: { ...scope, id: { gt: floor, lte: cursor }, createdAt: { gte: since } },
          orderBy: { id: "asc" },
        }),
        this.db.processEvent.findMany({
          where: { ...scope, id: { gt: cursor } },
          orderBy: { id: "asc" },
          take: BATCH,
        }),
      ]);

      for (const row of [...late, ...fresh]) {
        if (recent.has(row.id)) continue;
        recent.set(row.id, row.createdAt.getTime());
        if (row.id > cursor) cursor = row.id;
        yield {
          seq: row.id,
          instanceId: row.instanceId,
          type: row.type,
          elementId: row.elementId ?? undefined,
          payload: row.payload,
          createdAt: row.createdAt,
        };
      }

      for (const [id, at] of recent) {
        if (at < since.getTime()) recent.delete(id);
      }

      if (fresh.length < BATCH) {
        await sleep(this.pollMs, undefined, { signal }).catch(() => undefined);
      }
    }
  }
}

/**
 * Element ids the instance is parked on, replayed from its event log so it is
 * right no matter which process ran it.
 */
export async function waitingActivities(
  db: PrismaClient,
  instanceId: string,
): Promise<string[]> {
  const events = await db.processEvent.findMany({
    where: {
      instanceId,
      type: { in: ["activity.wait", "activity.end", "activity.error", "process.cancel"] },
    },
    orderBy: { id: "asc" },
    select: { type: true, elementId: true },
  });

  const waiting = new Set<string>();
  for (const event of events) {
    // A canceled instance waits on nothing any more.
    if (event.type === "process.cancel") waiting.clear();
    if (event.elementId === null) continue;
    if (event.type === "activity.wait") waiting.add(event.elementId);
    else waiting.delete(event.elementId);
  }
  return [...waiting];
}
