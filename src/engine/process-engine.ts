import { BpmnModdle } from "bpmn-moddle";
import type { PrismaClient } from "../db/client.js";
import type { Prisma } from "../gen/prisma/client.js";
import { EventFeed, waitingActivities } from "./event-feed.js";

export type InstanceStatus = "pending" | "running" | "completed" | "failed";

/** Concurrent deploys of one name race for the same version; retry this often. */
const DEPLOY_ATTEMPTS = 5;

/** Any UUID; definition ids are UUIDv7, and names may not look like one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Prisma's unique-constraint violation. */
function isUniqueViolation(cause: unknown): boolean {
  return (cause as { code?: unknown } | null)?.code === "P2002";
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid_argument" | "failed_precondition",
  ) {
    super(message);
    this.name = "ProcessError";
  }
}

/**
 * The API side of struna: stores definitions and records what should happen
 * to instances. It never executes BPMN — starts and signals are queued in the
 * database and carried out by a {@link Worker}, which may live in this process
 * or another one sharing the same database.
 */
export class ProcessEngine {
  readonly events: EventFeed;
  readonly #moddle = new BpmnModdle();

  constructor(private readonly db: PrismaClient) {
    this.events = new EventFeed(db);
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
    try {
      await this.#moddle.fromXML(source);
    } catch (cause) {
      throw new ProcessError(
        `invalid BPMN source: ${cause instanceof Error ? cause.message : String(cause)}`,
        "invalid_argument",
      );
    }

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
        where: { instanceId, type: { in: ["activity.end", "activity.error"] } },
        select: { type: true, elementId: true },
      }),
      this.waitingActivities(instanceId),
    ]);

    const done = new Set<string>();
    const failed = new Set<string>();
    for (const event of events) {
      if (event.elementId === null) continue;
      (event.type === "activity.end" ? done : failed).add(event.elementId);
    }
    return { done: [...done], failed: [...failed], waiting };
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
    if (instance.status === "completed" || instance.status === "failed") {
      throw new ProcessError(
        `instance ${id} is ${instance.status}`,
        "failed_precondition",
      );
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
}
