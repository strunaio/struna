import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { Engine, type BpmnEngineExecutionState } from "bpmn-engine";
import { Timers } from "bpmn-elements";
import type { PrismaClient } from "../db/client.js";
import { Prisma } from "../gen/prisma/client.js";
import { waitingActivities } from "./event-feed.js";
import { DEFAULT_PAYLOAD_POLICY, sanitize, type PayloadPolicy } from "./payload.js";
import type { InstanceStatus } from "./process-engine.js";

/** Engine events worth persisting; the engine emits far more than this. */
const RECORDED_EVENTS = [
  "activity.start",
  "activity.wait",
  "activity.end",
  "activity.error",
  "process.start",
  "process.end",
  "process.error",
  // Which branch a gateway took; the inspector and the diagram show it.
  "flow.take",
] as const;

/** Events after which the engine may have come to rest. */
const SETTLE_EVENTS = [...RECORDED_EVENTS, "activity.timer", "activity.leave"];

/** Activity statuses where nothing will happen without a signal or a timer. */
const AT_REST = new Set(["wait", "timer", "idle"]);

export interface WorkerOptions {
  /** Identifies this worker in `lockedBy`. Defaults to host, pid and a nonce. */
  readonly id?: string;
  /** How long a claim stays valid without a heartbeat. */
  readonly leaseMs?: number;
  /**
   * How long one instance may run before it is stopped and parked for the
   * next tick — this is what bounds a service task that never returns.
   */
  readonly runTimeoutMs?: number;
  /** Masking and size cap for data written to the event log. */
  readonly payloadPolicy?: PayloadPolicy;
}

export interface TickOptions {
  /** Stop claiming new instances after this long. */
  readonly budgetMs?: number;
  /** Process at most this many instances. */
  readonly maxItems?: number;
}

export interface TickResult {
  readonly processed: number;
  /** True when the tick stopped on its budget or cap rather than an empty queue. */
  readonly more: boolean;
}

type Outcome =
  | { readonly kind: "completed"; readonly variables: Record<string, unknown> }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "canceled"; readonly reason: string | null }
  | {
      readonly kind: "parked";
      readonly state: Prisma.InputJsonValue;
      readonly variables: Record<string, unknown>;
      readonly wakeAt: Date | null;
    };

interface Signal {
  readonly id: bigint;
  readonly elementId: string;
  readonly payload: Prisma.JsonValue;
}

/** A `jsonb` column's value as the object it was written as. */
function asObject(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

class LeaseLost extends Error {
  constructor(instanceId: string) {
    super(`lease on ${instanceId} was taken over`);
    this.name = "LeaseLost";
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A timer set by a BPMN timer event (its owner carries a `timerType`). */
function isBpmnTimer(owner: unknown): boolean {
  return typeof (owner as { timerType?: unknown } | null)?.timerType === "string";
}

/**
 * Timers where BPMN timer events never fire in memory. The worker lets go of
 * an instance as soon as it is at rest, so such a timeout would be lost;
 * instead its `timerRef` holds the due time, which becomes the instance's
 * `runnableAt`. On resume bpmn-elements recomputes the delay from the saved
 * expiry and fires an elapsed timer at once.
 *
 * Every other timer — a script's `setTimeout(next, …)`, say — is real: it is
 * part of the run in progress, and deferring it would park the instance
 * mid-script and re-run the script on every resume, forever.
 */
class DeferredTimers extends Timers {
  constructor() {
    super({
      setTimeout: (callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) =>
        setTimeout(callback, delay, ...args),
      // A deferred timer's ref is its due time, not a handle: nothing to clear.
      clearTimeout: (ref: unknown) => {
        if (typeof ref !== "number") clearTimeout(ref as NodeJS.Timeout);
      },
    });
  }

  /** bpmn-elements' internal hook: every timer, with its owner, goes through here. */
  _setTimeout(owner: unknown, callback: CallableFunction, delay: number, ...args: unknown[]): unknown {
    const base = Timers.prototype as unknown as {
      _setTimeout(this: Timers, ...a: unknown[]): unknown;
    };
    if (!isBpmnTimer(owner)) return base._setTimeout.call(this, owner, callback, delay, ...args);

    const options = this.options as { setTimeout: (cb: unknown, delay: number) => unknown };
    const real = options.setTimeout;
    options.setTimeout = (_callback, ms) => Date.now() + ms;
    try {
      return base._setTimeout.call(this, owner, callback, delay, ...args);
    } finally {
      options.setTimeout = real;
    }
  }
}

function deferredTimers(): Timers {
  return new DeferredTimers();
}

interface ActivityLike {
  readonly id: string;
  readonly environment: { readonly variables: Record<string, unknown> };
  on(event: string, handler: (api: { content?: { output?: unknown } }) => void, options?: { consumerTag?: string }): void;
  readonly broker: { cancel(consumerTag: string): void };
}

/**
 * bpmn-engine extension: when a task ends, keep its result — the payload it
 * was signalled with, or what a script passed to `next(null, …)` — in the
 * process variables under the task's id. bpmn-engine itself hands a result
 * only to the flows leaving that task; this makes an approval readable by the
 * gateway after it (`environment.variables.review.approved`), by later tasks,
 * and in the inspector.
 */
const TASK_RESULTS_TAG = "_struna-task-results";
const extensions = {
  taskResults(activity: ActivityLike) {
    return {
      activate() {
        activity.on(
          "end",
          (api) => {
            const output = api?.content?.output;
            if (output !== undefined && output !== null) {
              activity.environment.variables[activity.id] = output;
            }
          },
          { consumerTag: TASK_RESULTS_TAG },
        );
      },
      deactivate() {
        activity.broker.cancel(TASK_RESULTS_TAG);
      },
    };
  },
};

/**
 * Keys bpmn-elements copies from its run message into a process's variables;
 * they are engine plumbing, not process data.
 */
const ENGINE_KEYS = new Set(["fields", "content", "properties"]);

interface ProcessLike {
  readonly environment: {
    readonly variables: Record<string, unknown>;
    readonly output: Record<string, unknown>;
  };
}

/**
 * The instance's data as its scripts and tasks see it. Variables a script
 * sets live on the process's own environment, not the engine's, so read them
 * from every process and fall back to the engine's when none has started.
 */
function processData(engine: Engine): {
  variables: Record<string, unknown>;
  output: Record<string, unknown>;
} {
  const variables: Record<string, unknown> = { ...engine.environment.variables };
  const output: Record<string, unknown> = { ...engine.environment.output };
  const definitions =
    (engine.execution as unknown as {
      definitions?: { getProcesses?(): ProcessLike[] }[];
    } | null)?.definitions ?? [];
  for (const definition of definitions) {
    for (const process of definition.getProcesses?.() ?? []) {
      for (const [key, value] of Object.entries(process.environment.variables)) {
        if (!ENGINE_KEYS.has(key)) variables[key] = value;
      }
      Object.assign(output, process.environment.output);
    }
  }
  // Plain JSON only: this goes into jsonb columns and event payloads.
  return JSON.parse(JSON.stringify({ variables, output })) as {
    variables: Record<string, unknown>;
    output: Record<string, unknown>;
  };
}

function nextTimer(engine: Engine): Date | null {
  let earliest: number | null = null;
  for (const timer of engine.environment.timers.executing) {
    // Only BPMN timers wake the instance later; a script's timer is part of
    // the run, which the worker waits out.
    if (!isBpmnTimer(timer.owner)) continue;
    // Delays past setTimeout's range are tracked without a timerRef.
    const due =
      typeof timer.timerRef === "number" ? timer.timerRef : Date.now() + timer.delay;
    if (earliest === null || due < earliest) earliest = due;
  }
  return earliest === null ? null : new Date(earliest);
}

/**
 * Executes queued work against the shared database. Any number of workers —
 * embedded in `struna serve`, standalone `struna worker`s, Tick RPCs — can run
 * at once: an instance is only touched by the worker holding its lease.
 *
 * A worker never keeps an engine between ticks. It claims an instance,
 * restores it, applies its queued signals, runs it until it is at rest, saves
 * it and lets go.
 */
export class Worker {
  readonly id: string;
  readonly #leaseMs: number;
  readonly #runTimeoutMs: number;
  readonly #payloadPolicy: PayloadPolicy;

  constructor(
    private readonly db: PrismaClient,
    options: WorkerOptions = {},
  ) {
    this.id = options.id ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.#leaseMs = options.leaseMs ?? 60_000;
    this.#runTimeoutMs = options.runTimeoutMs ?? 30_000;
    this.#payloadPolicy = options.payloadPolicy ?? DEFAULT_PAYLOAD_POLICY;
  }

  /** Run whatever is due now, within the given budget. */
  async tick(options: TickOptions = {}): Promise<TickResult> {
    const deadline = Date.now() + (options.budgetMs ?? 10_000);
    const maxItems = options.maxItems ?? 100;

    let processed = 0;
    while (processed < maxItems && Date.now() < deadline) {
      const id = await this.#claim();
      if (id === null) return { processed, more: false };
      try {
        await this.#process(id);
      } catch (cause) {
        // Another worker reclaimed it after our lease lapsed; its run wins.
        if (!(cause instanceof LeaseLost)) throw cause;
      }
      processed++;
    }
    return { processed, more: true };
  }

  /**
   * Take the oldest runnable instance nobody holds, in one statement.
   * `SKIP LOCKED` lets concurrent workers pass over a row another claim is
   * taking instead of queueing behind it. Times come from this process, like
   * every other lease and schedule timestamp, so they compare consistently.
   */
  async #claim(): Promise<string | null> {
    const now = new Date();
    const until = new Date(now.getTime() + this.#leaseMs);
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE process_instances
         SET locked_by = ${this.id}, locked_until = ${until}
       WHERE id = (
               SELECT id FROM process_instances
                WHERE runnable_at <= ${now}
                  AND (locked_until IS NULL OR locked_until < ${now})
                ORDER BY runnable_at
                LIMIT 1
                  FOR UPDATE SKIP LOCKED
             )
      RETURNING id::text AS id`;
    return rows[0]?.id ?? null;
  }

  async #process(id: string): Promise<void> {
    const heartbeat = setInterval(() => {
      void this.db.processInstance
        .updateMany({
          where: { id, lockedBy: this.id },
          data: { lockedUntil: new Date(Date.now() + this.#leaseMs) },
        })
        .catch(() => undefined);
    }, this.#leaseMs / 3);
    heartbeat.unref();

    try {
      const instance = await this.db.processInstance.findUniqueOrThrow({
        where: { id },
        include: { definition: true },
      });
      // Asked to stop: do that instead of running it.
      if (instance.cancelRequestedAt !== null) {
        await this.#release(id, { kind: "canceled", reason: instance.cancelReason }, []);
        return;
      }

      const signals = await this.db.processSignal.findMany({
        where: { instanceId: id },
        orderBy: { id: "asc" },
      });

      const run = new InstanceRun(this.db, id, this.#payloadPolicy);
      let outcome: Outcome;
      try {
        outcome = await run.execute({
          name: `${instance.definition.name}@${instance.definition.version}`,
          source: instance.definition.source,
          variables: asObject(instance.variables),
          state: instance.state,
          signals,
          runTimeoutMs: this.#runTimeoutMs,
        });
      } catch (cause) {
        outcome = { kind: "failed", error: message(cause) };
      }
      await run.flush();
      await this.#release(id, outcome, run.consumed);
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Save the outcome and drop the lease, only if the lease is still ours. */
  async #release(id: string, outcome: Outcome, consumed: bigint[]): Promise<void> {
    const now = new Date();
    const finished = outcome.kind !== "parked";

    const data =
      outcome.kind === "completed"
        ? {
            status: "completed" satisfies InstanceStatus,
            completedAt: now,
            variables: outcome.variables as Prisma.InputJsonObject,
            state: Prisma.DbNull,
            runnableAt: null,
          }
        : outcome.kind === "failed"
          ? {
              status: "failed" satisfies InstanceStatus,
              completedAt: now,
              error: outcome.error,
              runnableAt: null,
            }
          : outcome.kind === "canceled"
            ? {
                // State stays: it is what the instance was doing when stopped.
                status: "canceled" satisfies InstanceStatus,
                completedAt: now,
                runnableAt: null,
              }
            : {
              status: "running" satisfies InstanceStatus,
              state: outcome.state,
              // Kept current, so reads never have to unpack engine state.
              variables: outcome.variables as Prisma.InputJsonObject,
              runnableAt: outcome.wakeAt,
            };

    await this.db.$transaction(async (tx) => {
      // Updating first takes the row lock, so a signal queued concurrently
      // either lands before the count below or wakes the instance after us.
      const { count } = await tx.processInstance.updateMany({
        where: { id, lockedBy: this.id },
        data: { ...data, lockedBy: null, lockedUntil: null },
      });
      if (count === 0) throw new LeaseLost(id);

      if (outcome.kind === "canceled") {
        await tx.processEvent.create({
          data: {
            instanceId: id,
            type: "process.cancel",
            payload: sanitize({ reason: outcome.reason }, this.#payloadPolicy),
          },
        });
      }
      if (outcome.kind === "failed") {
        // The failed run's work is thrown away (its state is not saved), so
        // the signals it consumed stay queued: a retry resumes from the last
        // saved state and applies them again.
        return;
      }
      if (finished) {
        await tx.processSignal.deleteMany({ where: { instanceId: id } });
        return;
      }

      // A cancel asked for while this run was in flight: wake the instance
      // so the next claim carries it out, like a signal queued meanwhile.
      const { cancelRequestedAt } = await tx.processInstance.findUniqueOrThrow({
        where: { id },
        select: { cancelRequestedAt: true },
      });
      if (cancelRequestedAt !== null) {
        await tx.processInstance.update({ where: { id }, data: { runnableAt: now } });
        return;
      }
      if (consumed.length > 0) {
        await tx.processSignal.deleteMany({ where: { id: { in: consumed } } });
      }
      const queued = await tx.processSignal.count({ where: { instanceId: id } });
      if (queued > 0) {
        await tx.processInstance.update({ where: { id }, data: { runnableAt: now } });
      }
    });
  }
}

/** One claimed instance, from restore to rest. */
class InstanceRun {
  readonly consumed: bigint[] = [];
  #writes: Promise<void> = Promise.resolve();
  #closed = false;
  /** Waits the log already has; a resumed engine announces them again. */
  #replayedWaits = new Set<string>();

  #engine: Engine | undefined;
  #finished: Exclude<Outcome, { kind: "parked" }> | undefined;
  #wake: (() => void) | undefined;
  /** The last variables snapshot logged, so unchanged ones are not repeated. */
  #loggedVariables: string | undefined;
  /** Activities that ended or failed in this run, to tell a leave from a discard. */
  #finishedActivities = new Set<string>();

  constructor(
    private readonly db: PrismaClient,
    private readonly instanceId: string,
    private readonly policy: PayloadPolicy,
  ) {}

  async execute(input: {
    name: string;
    source: string;
    variables: Record<string, unknown>;
    state: Prisma.JsonValue;
    signals: readonly Signal[];
    runTimeoutMs: number;
  }): Promise<Outcome> {
    const deadline = Date.now() + input.runTimeoutMs;
    const listener = this.#listener();

    let engine: Engine;
    if (input.state === null) {
      engine = new Engine({
        name: input.name,
        source: input.source,
        variables: input.variables,
        timers: deferredTimers(),
        extensions,
      });
      this.#watch(engine);
      await engine.execute({ listener });
    } else {
      const state = input.state as unknown as BpmnEngineExecutionState;
      // What the log last saw: the variables saved when it was parked.
      this.#loggedVariables = this.#snapshotKey(input.variables, {});
      engine = new Engine({ timers: deferredTimers(), extensions }).recover(state);
      this.#watch(engine);
      this.#replayedWaits = new Set(await waitingActivities(this.db, this.instanceId));
      await engine.resume({ listener });
    }

    let atRest = await this.#settle(deadline);
    this.#replayedWaits.clear();

    for (const signal of input.signals) {
      if (!atRest || this.#finished !== undefined) break;
      const execution = engine.execution;
      if (execution === null) break;
      // A signal for an element that is not waiting is ignored by the engine;
      // it is still consumed so it cannot fire at some later wait.
      this.#record("signal", signal.elementId, signal.payload);
      execution.signal({
        id: signal.elementId,
        ...asObject(signal.payload),
      });
      this.consumed.push(signal.id);
      atRest = await this.#settle(deadline);
    }

    if (this.#finished !== undefined) return this.#finished;

    // Either at rest, or out of time: in both cases save and let go. A run
    // that timed out resumes on the next tick, repeating its in-flight step.
    const wakeAt = atRest ? nextTimer(engine) : new Date();
    // Round-trip through JSON so jsonb gets plain data (no undefined, no Dates).
    const state = JSON.parse(JSON.stringify(await engine.getState())) as Prisma.InputJsonValue;
    const { variables } = processData(engine);
    await engine.stop();
    return { kind: "parked", state, variables, wakeAt };
  }

  /** Wait for queued event writes, then ignore anything the engine still emits. */
  async flush(): Promise<void> {
    await this.#writes;
    this.#closed = true;
  }

  #watch(engine: Engine): void {
    this.#engine = engine;
    engine.once("end", () => {
      this.#finished ??= { kind: "completed", variables: processData(engine).variables };
      this.#wake?.();
    });
    engine.on("error", (cause: unknown) => {
      this.#finished ??= { kind: "failed", error: message(cause) };
      this.#wake?.();
    });
  }

  /** Resolve true once the engine is at rest or done, false at the deadline. */
  async #settle(deadline: number): Promise<boolean> {
    for (;;) {
      // Let the engine's synchronous cascade and any queued callbacks run.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.#finished !== undefined) return true;
      if (AT_REST.has(this.#engine?.execution?.activityStatus ?? "idle")) return true;

      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.#wake = undefined;
    }
  }

  #listener(): EventEmitter {
    const listener = new EventEmitter();
    listener.setMaxListeners(0);

    for (const type of SETTLE_EVENTS) {
      listener.on(type, () => this.#wake?.());
    }
    for (const type of RECORDED_EVENTS) {
      listener.on(
        type,
        (api: { id?: string; content?: { id?: string; output?: unknown } }) => {
          const elementId = api?.id ?? api?.content?.id;
          if (type === "activity.wait" && elementId !== undefined) {
            if (this.#replayedWaits.delete(elementId)) return;
          }
          if (elementId !== undefined) {
            if (type === "activity.start") this.#finishedActivities.delete(elementId);
            if (type === "activity.end" || type === "activity.error") {
              this.#finishedActivities.add(elementId);
            }
          }
          const output = api?.content?.output;
          this.#record(
            type,
            elementId,
            type === "activity.end" && output !== undefined ? { output } : undefined,
          );
          // Data moves at the start and whenever an element finishes.
          if (type === "process.start" || type === "activity.end") {
            this.#snapshotVariables(elementId);
          }
        },
      );
    }
    // Leaving without ending means the activity was cut short — an
    // interrupting boundary event fired, say. Log that, or the task would
    // look like it is still waiting.
    listener.on("activity.leave", (api: { id?: string }) => {
      const elementId = api?.id;
      if (elementId === undefined) return;
      if (this.#finishedActivities.delete(elementId)) return;
      this.#record("activity.discard", elementId);
    });
    return listener;
  }

  /** The logged form of a snapshot, used to tell whether anything changed. */
  #snapshotKey(variables: unknown, output: unknown): string {
    return JSON.stringify(sanitize({ variables, output }, this.policy));
  }

  /**
   * Log a `variables` event, attributed to the element that just finished,
   * when the instance's data differs from the last snapshot.
   */
  #snapshotVariables(elementId: string | undefined): void {
    if (this.#engine === undefined) return;
    const { variables, output } = processData(this.#engine);
    const key = this.#snapshotKey(variables, output);
    if (key === this.#loggedVariables) return;
    this.#loggedVariables = key;
    this.#record("variables", elementId, { variables, output });
  }

  /**
   * Append to the event log in emission order; `seq` must follow it. The
   * payload is masked and capped here, at the moment it is captured.
   */
  #record(type: string, elementId: string | undefined, payload?: unknown): void {
    if (this.#closed) return;
    const createdAt = new Date();
    const data = payload === undefined ? undefined : sanitize(payload, this.policy);
    this.#writes = this.#writes
      .then(async () => {
        await this.db.processEvent.create({
          data: {
            instanceId: this.instanceId,
            type,
            elementId: elementId ?? null,
            ...(data === undefined ? {} : { payload: data }),
            createdAt,
          },
        });
      })
      // An unrecordable event must not take down a running process.
      .catch(() => undefined);
  }
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Tick until `signal` aborts, sleeping `idleMs` whenever the queue runs dry.
 * Failed ticks (e.g. the database is unreachable) back off exponentially up
 * to 30s. The current tick always finishes, so its instances are saved, not
 * dropped.
 */
export async function runWorker(
  worker: Worker,
  options: {
    readonly signal: AbortSignal;
    readonly idleMs?: number;
    readonly tick?: TickOptions;
    readonly onError?: (cause: unknown) => void;
  },
): Promise<void> {
  const { signal, idleMs = 1_000 } = options;
  let failures = 0;
  while (!signal.aborted) {
    let delay = 0;
    try {
      const { more } = await worker.tick(options.tick);
      failures = 0;
      if (!more) delay = idleMs;
    } catch (cause) {
      options.onError?.(cause);
      failures++;
      delay = Math.min(idleMs * 2 ** failures, MAX_BACKOFF_MS);
    }
    if (delay > 0) await sleep(delay, undefined, { signal }).catch(() => undefined);
  }
}
