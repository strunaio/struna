import type { DescField, DescMessage } from "@bufbuild/protobuf";
import { BpmnModdle } from "bpmn-moddle";
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../gen/prisma/client.js";
import { ProcessError } from "./errors.js";
import { parseExpression } from "feelin";
import { inputMappings, methodOf, moddleOptions, outputMappings, taskHeaders } from "./bpmn-extensions.js";
import { zeebeScript } from "./feel-scripts.js";
import { EventFeed, waitingActivities } from "./event-feed.js";
import { DEFAULT_PAYLOAD_POLICY, redact, type PayloadPolicy } from "./payload.js";
import { findField, ServiceRegistry } from "./registry.js";

/** Where a FEEL expression stops parsing, or undefined when it parses. */
function feelSyntaxError(expression: string): number | undefined {
  let at: number | undefined;
  parseExpression(expression, {}, undefined).iterate({
    enter: (node) => {
      if (at === undefined && node.type.isError) at = node.from;
    },
  });
  return at;
}

export type InstanceStatus = "pending" | "running" | "completed" | "failed" | "canceled";

/** Statuses an instance can still move out of by itself. */
const ACTIVE: InstanceStatus[] = ["pending", "running"];

/** Concurrent deploys of one name race for the same version; retry this often. */
const DEPLOY_ATTEMPTS = 5;

/** Any UUID; definition ids are UUIDv7, and names may not look like one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Prisma's unique-constraint violation. */
function isUniqueViolation(cause: unknown): boolean {
  return (cause as { code?: unknown } | null)?.code === "P2002";
}

export { ProcessError } from "./errors.js";

/**
 * The API side of struna: stores definitions and records what should happen
 * to instances. It never executes BPMN — starts and signals are queued in the
 * database and carried out by a {@link Worker}, which may live in this process
 * or another one sharing the same database.
 */
/** Event types that describe one element's run, for the inspector. */
const ELEMENT_EVENTS = [
  "activity.start",
  "activity.wait",
  "activity.end",
  "activity.error",
  "activity.discard",
  "signal",
  "inputs",
  "outputs",
];

/** One evaluated input or output mapping, as the log records it. */
export interface MappingRow {
  readonly target: string;
  /** Output rows: "mapping", "expression", "merged", "whole", or "local" (stayed in the step). Inputs have none. */
  readonly kind?: string;
  readonly source: string;
  readonly value: Prisma.JsonValue;
}

export interface ElementRun {
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly waitedAt: Date | null;
  readonly failed: boolean;
  /** Cut short without ending, e.g. by an interrupting boundary event. */
  readonly interrupted: boolean;
  readonly signals: { readonly at: Date; readonly payload: Prisma.JsonValue }[];
  /** Its input mappings as evaluated when it started (its local variables). */
  readonly inputs: MappingRow[];
  /** What its result wrote to the process variables, and from where. */
  readonly outputs: MappingRow[];
  readonly output: Prisma.JsonValue | undefined;
  /** Instance data as this run left it, or as it is now for a run still open. */
  readonly variables: Prisma.JsonValue | undefined;
  /** The process variables this run added, changed or removed; undefined while it is open. */
  readonly changes: VariableChange[] | undefined;
}

/** One process variable a run touched, with its (masked) value before and after. */
export interface VariableChange {
  readonly name: string;
  readonly kind: "added" | "changed" | "removed";
  readonly before?: Prisma.JsonValue;
  readonly after?: Prisma.JsonValue;
}

function snapshotVariables(snapshot: Prisma.JsonValue | undefined): Record<string, Prisma.JsonValue> {
  const variables = (snapshot as { variables?: unknown } | null | undefined)?.variables;
  return typeof variables === "object" && variables !== null && !Array.isArray(variables)
    ? (variables as Record<string, Prisma.JsonValue>)
    : {};
}

/** Top-level differences between two snapshots, in the order the variables appear. */
export function variableChanges(
  before: Prisma.JsonValue | undefined,
  after: Prisma.JsonValue | undefined,
): VariableChange[] {
  const was = snapshotVariables(before);
  const now = snapshotVariables(after);
  const changes: VariableChange[] = [];
  for (const [name, value] of Object.entries(now)) {
    if (!(name in was)) changes.push({ name, kind: "added", after: value });
    else if (JSON.stringify(was[name]) !== JSON.stringify(value)) {
      changes.push({ name, kind: "changed", before: was[name] as Prisma.JsonValue, after: value });
    }
  }
  for (const [name, value] of Object.entries(was)) {
    if (!(name in now)) changes.push({ name, kind: "removed", before: value });
  }
  return changes;
}

export class ProcessEngine {
  readonly events: EventFeed;
  readonly registry: ServiceRegistry;
  readonly #moddle = new BpmnModdle(moddleOptions);
  readonly #policy: PayloadPolicy;

  constructor(
    private readonly db: PrismaClient,
    options: { readonly payloadPolicy?: PayloadPolicy; readonly registry?: ServiceRegistry } = {},
  ) {
    this.events = new EventFeed(db);
    this.#policy = options.payloadPolicy ?? DEFAULT_PAYLOAD_POLICY;
    this.registry = options.registry ?? new ServiceRegistry(db);
  }

  /** Mask sensitive keys before data is shown; the API returns it as stored. */
  redact(value: unknown): Prisma.JsonValue {
    return redact(value, this.#policy);
  }

  /** Parse-check the BPMN XML and store it as the next version of `name`. */
  async deploy(name: string, source: string) {
    if (name.trim() === "") {
      throw new ProcessError("name must not be empty", "invalid_argument");
    }
    if (UUID.test(name)) {
      // Keeps StartInstance's id-or-name lookup unambiguous.
      throw new ProcessError("name must not be a UUID", "invalid_argument");
    }
    let elementsById: Record<string, unknown>;
    try {
      ({ elementsById } = await this.#moddle.fromXML(source));
    } catch (cause) {
      throw new ProcessError(
        `invalid BPMN source: ${cause instanceof Error ? cause.message : String(cause)}`,
        "invalid_argument",
      );
    }
    this.#checkFeel(elementsById);
    await this.#checkServiceTasks(elementsById);

    // Read the latest version, claim the next one. Two deploys of the same
    // name can read the same latest; the loser hits (name, version) and
    // tries again with a fresh read.
    for (let attempt = 1; ; attempt++) {
      const latest = await this.db.processDefinition.findFirst({
        where: { name },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      try {
        return await this.db.processDefinition.create({
          data: { name, source, version: (latest?.version ?? 0) + 1 },
        });
      } catch (cause) {
        if (!isUniqueViolation(cause) || attempt >= DEPLOY_ATTEMPTS) throw cause;
      }
    }
  }

  /**
   * FEEL that does not parse, anywhere a task takes it — inputs, outputs,
   * `resultExpression` — fails the deploy. Only the syntax is checked:
   * evaluating without the variables would trip over valid expressions,
   * e.g. `string(a)` with `a` still unknown.
   */
  #checkFeel(elementsById: Record<string, unknown>): void {
    const check = (id: string | undefined, what: string, source: string) => {
      if (!source.startsWith("=")) return;
      const at = feelSyntaxError(source.slice(1));
      if (at !== undefined) {
        throw new ProcessError(`${id}: ${what} is not valid FEEL: syntax error at position ${at}`, "invalid_argument");
      }
    };
    for (const element of Object.values(elementsById)) {
      const { id, $type, extensionElements, conditionExpression } = element as {
        id?: string;
        $type?: string;
        extensionElements?: unknown;
        conditionExpression?: { body?: string; language?: string };
      };
      const condition = conditionExpression?.body?.trim();
      if (condition !== undefined && conditionExpression?.language === undefined) check(id, "condition", condition);
      if ($type === "bpmn:ScriptTask") {
        const script = zeebeScript(extensionElements);
        if (script !== undefined) {
          check(id, "script", script.expression.startsWith("=") ? script.expression : `=${script.expression}`);
          if (script.resultVariable === undefined) {
            throw new ProcessError(`${id}: a zeebe:script needs a resultVariable`, "invalid_argument");
          }
        }
      }
      if (extensionElements === undefined) continue;
      for (const input of inputMappings(extensionElements)) check(id, `input "${input.target}"`, input.source);
      for (const output of outputMappings(extensionElements)) check(id, `output "${output.target}"`, output.source);
      const expression = taskHeaders(extensionElements)["resultExpression"];
      if (expression !== undefined) check(id, "resultExpression", expression);
    }
  }

  /**
   * Fail the deploy, not a run halfway through, when a service task cannot
   * work: no method, a method nobody registered, an input that is not a field
   * of its request, or FEEL that does not parse.
   */
  async #checkServiceTasks(elementsById: Record<string, unknown>): Promise<void> {
    for (const element of Object.values(elementsById)) {
      const task = element as { $type?: string; id?: string; method?: string; extensionElements?: unknown };
      if (task.$type !== "bpmn:ServiceTask") continue;
      const method = methodOf(task);
      if (method === undefined) {
        throw new ProcessError(
          `service task ${task.id}: set <zeebe:taskDefinition type="package.Service/Method" /> — struna runs service tasks by calling a registered method`,
          "invalid_argument",
        );
      }
      let resolved;
      try {
        resolved = await this.registry.resolve(method);
      } catch (cause) {
        throw new ProcessError(
          `service task ${task.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
          "invalid_argument",
        );
      }
      for (const input of inputMappings(task.extensionElements)) {
        let message: DescMessage | undefined = resolved.method.input;
        for (const segment of input.target.split(".")) {
          const field: DescField | undefined =
            message === undefined ? undefined : findField(message, segment);
          if (field === undefined) {
            throw new ProcessError(
              `service task ${task.id}: ${resolved.method.input.typeName} has no field "${input.target}"`,
              "invalid_argument",
            );
          }
          message = field.fieldKind === "message" ? field.message : undefined;
        }
      }
    }
  }

  listDefinitions(take: number, skip: number) {
    return this.db.processDefinition.findMany({
      orderBy: [{ name: "asc" }, { version: "desc" }],
      take,
      skip,
    });
  }

  listInstances(take: number) {
    return this.db.processInstance.findMany({
      orderBy: { startedAt: "desc" },
      take,
      include: { definition: { select: { name: true, version: true } } },
    });
  }

  recentEvents(take: number) {
    return this.db.processEvent.findMany({ orderBy: { id: "desc" }, take });
  }

  async getDefinition(id: string) {
    // A uuid column rejects malformed input outright; that is still "no such".
    const definition = UUID.test(id)
      ? await this.db.processDefinition.findUnique({ where: { id } })
      : null;
    if (definition === null) {
      throw new ProcessError(`no definition ${id}`, "not_found");
    }
    return definition;
  }

  /**
   * The latest finished runs of the given tasks (definition + element), newest
   * first: what a service's page lists as its recent calls.
   */
  recentTaskRuns(tasks: readonly { definitionId: string; elementId: string }[], take: number) {
    if (tasks.length === 0) return Promise.resolve([]);
    return this.db.processEvent.findMany({
      where: {
        type: { in: ["activity.end", "activity.error"] },
        OR: tasks.map((task) => ({ elementId: task.elementId, instance: { definitionId: task.definitionId } })),
      },
      orderBy: { id: "desc" },
      take,
      include: { instance: { select: { id: true, status: true, definitionId: true } } },
    });
  }

  /** Element ids the instance is currently parked on. */
  waitingActivities(instanceId: string): Promise<string[]> {
    return waitingActivities(this.db, instanceId);
  }

  /** The instance's event log, oldest first. */
  instanceEvents(instanceId: string) {
    return this.db.processEvent.findMany({
      where: { instanceId },
      orderBy: { id: "asc" },
    });
  }

  /**
   * Where each element stands, from the event log: what has finished, what
   * failed, and what is waiting now. The diagram view colours elements by it.
   */
  async elementProgress(instanceId: string) {
    const [events, waiting] = await Promise.all([
      this.db.processEvent.findMany({
        where: {
          instanceId,
          type: { in: ["activity.start", "activity.end", "activity.error", "flow.take"] },
        },
        select: { type: true, elementId: true },
      }),
      this.waitingActivities(instanceId),
    ]);

    const done = new Set<string>();
    const failed = new Set<string>();
    /** How many times each element started — loops show as a count. */
    const runs: Record<string, number> = {};
    /** How many times each sequence flow was taken. */
    const taken: Record<string, number> = {};
    for (const event of events) {
      if (event.elementId === null) continue;
      if (event.type === "activity.start") {
        runs[event.elementId] = (runs[event.elementId] ?? 0) + 1;
      } else if (event.type === "flow.take") {
        taken[event.elementId] = (taken[event.elementId] ?? 0) + 1;
      } else {
        (event.type === "activity.end" ? done : failed).add(event.elementId);
      }
    }
    return { done: [...done], failed: [...failed], waiting, runs, taken };
  }

  /**
   * Everything the log knows about one element of an instance, one entry per
   * time it ran: when it started, waited and ended, the signals it received,
   * its output, and the instance's variables right after it finished.
   */
  async elementRuns(instanceId: string, elementId: string): Promise<ElementRun[]> {
    const instance = await this.getInstance(instanceId);
    const [events, snapshots] = await Promise.all([
      this.db.processEvent.findMany({
        where: { instanceId, elementId, type: { in: ELEMENT_EVENTS } },
        orderBy: { id: "asc" },
      }),
      this.db.processEvent.findMany({
        where: { instanceId, type: "variables" },
        orderBy: { id: "asc" },
        select: { id: true, elementId: true, payload: true },
      }),
    ]);

    interface Draft {
      startedAt: Date | null;
      endedAt: Date | null;
      waitedAt: Date | null;
      failed: boolean;
      interrupted: boolean;
      signals: { at: Date; payload: Prisma.JsonValue }[];
      inputs: MappingRow[];
      outputs: MappingRow[];
      output: Prisma.JsonValue | undefined;
      startId: bigint | null;
      endId: bigint | null;
    }
    const runs: Draft[] = [];
    const current = (): Draft => {
      let run = runs.at(-1);
      if (run === undefined) {
        run = { startedAt: null, endedAt: null, waitedAt: null, failed: false, interrupted: false,
                signals: [], inputs: [], outputs: [], output: undefined, startId: null, endId: null };
        runs.push(run);
      }
      return run;
    };
    for (const event of events) {
      const payload = event.payload as { output?: Prisma.JsonValue } | null;
      switch (event.type) {
        case "activity.start":
          runs.push({ startedAt: event.createdAt, endedAt: null, waitedAt: null, failed: false,
                      interrupted: false, signals: [], inputs: [], outputs: [], output: undefined,
                      startId: event.id, endId: null });
          break;
        case "activity.wait":
          current().waitedAt = event.createdAt;
          break;
        case "signal":
          current().signals.push({ at: event.createdAt, payload: event.payload });
          break;
        case "inputs":
        case "outputs": {
          const rows = ((event.payload as { mappings?: MappingRow[] } | null)?.mappings ?? []);
          current()[event.type].push(...rows);
          break;
        }
        case "activity.end": {
          const run = current();
          run.endedAt = event.createdAt;
          run.endId = event.id;
          run.output = payload?.output;
          break;
        }
        case "activity.error":
          current().failed = true;
          break;
        case "activity.discard": {
          const run = current();
          run.interrupted = true;
          run.endedAt = event.createdAt;
          break;
        }
      }
    }

    return runs.map((run, index) => {
      const nextStart = runs[index + 1]?.startId ?? null;
      let variables: Prisma.JsonValue | undefined;
      let changes: VariableChange[] | undefined;
      if (run.interrupted) {
        variables = undefined;
      } else if (run.endId === null) {
        // Still open: the instance's data as it is now.
        variables = this.redact({ variables: instance.variables });
      } else {
        const endId = run.endId;
        // The snapshot this element wrote when it finished; if its data did
        // not change, none was written, so the latest earlier one applies.
        const own = snapshots.find(
          (s) => s.elementId === elementId && s.id > endId && (nextStart === null || s.id < nextStart),
        );
        variables = (own ?? snapshots.filter((s) => s.id < endId).at(-1))?.payload;
        // Only its own snapshot says what it changed, measured against the
        // one just before — so a parallel branch's writes are not pinned on it.
        changes = own === undefined ? [] : variableChanges(snapshots.filter((s) => s.id < own.id).at(-1)?.payload, own.payload);
      }
      return {
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        waitedAt: run.waitedAt,
        failed: run.failed,
        interrupted: run.interrupted,
        signals: run.signals,
        inputs: run.inputs,
        outputs: run.outputs,
        output: run.output,
        variables,
        changes,
      };
    });
  }

  async getInstance(id: string) {
    const instance = UUID.test(id)
      ? await this.db.processInstance.findUnique({ where: { id } })
      : null;
    if (instance === null) {
      throw new ProcessError(`no instance ${id}`, "not_found");
    }
    return instance;
  }

  /** The highest deployed version of `name`. */
  async latestDefinition(name: string) {
    const definition = await this.db.processDefinition.findFirst({
      where: { name },
      orderBy: { version: "desc" },
    });
    if (definition === null) {
      throw new ProcessError(`no definition named ${name}`, "not_found");
    }
    return definition;
  }

  /**
   * Start a definition given its id (that exact version) or its name (the
   * latest version).
   */
  async startByIdOrName(idOrName: string, variables: Record<string, unknown>) {
    if (idOrName === "") {
      throw new ProcessError("definition_id_or_name must not be empty", "invalid_argument");
    }
    if (UUID.test(idOrName)) return this.start(idOrName, variables);
    const definition = await this.latestDefinition(idOrName);
    return this.start(definition.id, variables);
  }

  /** Create a `pending` instance for a worker to pick up. */
  async start(definitionId: string, variables: Record<string, unknown>) {
    await this.getDefinition(definitionId);

    return this.db.processInstance.create({
      data: {
        definitionId,
        status: "pending" satisfies InstanceStatus,
        variables: variables as Prisma.InputJsonObject,
        runnableAt: new Date(),
      },
    });
  }

  /**
   * Queue a message for a waiting element. A worker delivers it in order with
   * any others; signals for an element that is not waiting are dropped then.
   */
  async signal(id: string, elementId: string, payload: Record<string, unknown>) {
    const instance = await this.getInstance(id);
    if (!ACTIVE.includes(instance.status as InstanceStatus)) {
      throw new ProcessError(
        `instance ${id} is ${instance.status}`,
        "failed_precondition",
      );
    }
    if (instance.cancelRequestedAt !== null) {
      throw new ProcessError(`instance ${id} is being canceled`, "failed_precondition");
    }

    // Insert before waking the instance: a worker that releases it in between
    // re-checks the inbox after taking the row lock, so the wake-up is not lost.
    await this.db.$transaction([
      this.db.processSignal.create({
        data: { instanceId: id, elementId, payload: payload as Prisma.InputJsonObject },
      }),
      this.db.processInstance.update({
        where: { id },
        data: { runnableAt: new Date() },
      }),
    ]);

    return this.getInstance(id);
  }

  /**
   * Ask for a pending or running instance to be stopped for good. The worker
   * that next holds it carries this out — so it never races a run in
   * progress — and records it; until then `cancelRequestedAt` shows it is
   * on its way. Asking again is a no-op.
   */
  async cancel(id: string, reason: string) {
    const instance = await this.getInstance(id);
    if (!ACTIVE.includes(instance.status as InstanceStatus)) {
      throw new ProcessError(`instance ${id} is ${instance.status}`, "failed_precondition");
    }
    if (instance.cancelRequestedAt !== null) return instance;

    const now = new Date();
    await this.db.processInstance.updateMany({
      where: { id, status: { in: ACTIVE }, cancelRequestedAt: null },
      // Wake it, even if it is parked on a timer far away.
      data: { cancelRequestedAt: now, cancelReason: reason.trim() || null, runnableAt: now },
    });
    return this.getInstance(id);
  }

  /**
   * Run a failed instance again from the last state a worker saved (where it
   * last waited): every step since then runs again, and the signals that run
   * consumed are applied again. One that failed before it was ever saved
   * starts over with its original variables.
   */
  async retry(id: string) {
    const instance = await this.getInstance(id);
    if (instance.status !== "failed") {
      throw new ProcessError(
        `only a failed instance can be retried; ${id} is ${instance.status}`,
        "failed_precondition",
      );
    }

    await this.db.$transaction([
      this.db.processInstance.updateMany({
        where: { id, status: "failed" },
        data: {
          status: (instance.state === null ? "pending" : "running") satisfies InstanceStatus,
          error: null,
          completedAt: null,
          runnableAt: new Date(),
        },
      }),
      // Marks the seam in the log: steps after it are the second attempt.
      this.db.processEvent.create({
        data: {
          instanceId: id,
          type: "process.retry",
          payload: { error: instance.error } as Prisma.InputJsonObject,
        },
      }),
    ]);
    return this.getInstance(id);
  }
}
