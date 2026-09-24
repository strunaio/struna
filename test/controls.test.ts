import { readFileSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { disconnectPrisma, prisma } from "../src/db/client.js";
import { ProcessEngine, ProcessError } from "../src/engine/process-engine.js";
import { Worker } from "../src/engine/worker.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const hello = readFileSync("examples/hello.bpmn", "utf8");

// start → slow (a script that takes a while) → end
const slow = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="slow-defs"
             targetNamespace="http://struna.io/bpmn">
  <process id="slow" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="work" />
    <scriptTask id="work" scriptFormat="javascript"><script>setTimeout(next, 400);</script></scriptTask>
    <sequenceFlow id="f2" sourceRef="work" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

// start → review (user task) → boom (a script that always fails)
const failing = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="failing-defs"
             targetNamespace="http://struna.io/bpmn">
  <process id="failing" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="review" />
    <userTask id="review" />
    <sequenceFlow id="f2" sourceRef="review" targetRef="boom" />
    <scriptTask id="boom" scriptFormat="javascript"><script>next(new Error("downstream is down"));</script></scriptTask>
    <sequenceFlow id="f3" sourceRef="boom" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

const db = prisma(TEST_DATABASE_URL);
const engine = new ProcessEngine(db);

afterAll(async () => {
  await disconnectPrisma();
});

async function drain(worker = new Worker(db)): Promise<void> {
  while ((await worker.tick()).more);
}

const count = (instanceId: string, type: string) =>
  db.processEvent.count({ where: { instanceId, type } });

test("a canceled pending instance never runs", async () => {
  const { id } = await engine.deploy("cancel-pending", hello);
  const instance = await engine.start(id, {});

  const requested = await engine.cancel(instance.id, "started by mistake");
  expect(requested.status).toBe("pending");
  expect(requested.cancelRequestedAt).not.toBeNull();
  await drain();

  const after = await engine.getInstance(instance.id);
  expect(after.status).toBe("canceled");
  expect(after.completedAt).not.toBeNull();
  expect(after.runnableAt).toBeNull();
  expect(await count(instance.id, "process.start")).toBe(0);
  const [cancel] = await db.processEvent.findMany({
    where: { instanceId: instance.id, type: "process.cancel" },
  });
  expect(cancel?.payload).toEqual({ reason: "started by mistake" });
});

test("a parked instance is canceled and waits on nothing", async () => {
  const { id } = await engine.deploy("cancel-parked", hello);
  const instance = await engine.start(id, {});
  await drain();
  expect(await engine.waitingActivities(instance.id)).toEqual(["review"]);

  await engine.cancel(instance.id, "");
  // A second request is a no-op, not an error.
  await engine.cancel(instance.id, "again");
  await expect(engine.signal(instance.id, "review", {})).rejects.toThrow(/being canceled/);
  await drain();

  expect((await engine.getInstance(instance.id)).status).toBe("canceled");
  expect(await engine.waitingActivities(instance.id)).toEqual([]);
  expect(await count(instance.id, "process.cancel")).toBe(1);
  await expect(engine.cancel(instance.id, "")).rejects.toBeInstanceOf(ProcessError);
});

test("a cancel sent while a worker is running the instance is not lost", async () => {
  const { id } = await engine.deploy("cancel-in-flight", slow);
  const instance = await engine.start(id, {});

  const worker = new Worker(db);
  const running = worker.tick();
  // The run is inside its 400ms script: the worker holds the lease.
  for (let i = 0; i < 50; i++) {
    if ((await engine.getInstance(instance.id)).lockedBy !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await engine.cancel(instance.id, "too slow");
  await running;
  await drain(worker);

  // The run in flight finished the process; the cancel came too late to
  // matter, and must not leave the instance stuck as runnable either way.
  const after = await engine.getInstance(instance.id);
  expect(["completed", "canceled"]).toContain(after.status);
  expect(after.runnableAt).toBeNull();
  expect(after.lockedBy).toBeNull();
});

test("a failed instance retries from its last saved state, with its signals", async () => {
  const { id } = await engine.deploy("retry-failed", failing);
  const instance = await engine.start(id, {});
  await drain();
  await engine.signal(instance.id, "review", { approved: true });
  await drain();

  const failed = await engine.getInstance(instance.id);
  expect(failed.status).toBe("failed");
  expect(failed.error).toContain("downstream is down");
  // The failed run's signal stays queued for the retry.
  expect(await db.processSignal.count({ where: { instanceId: instance.id } })).toBe(1);

  const retried = await engine.retry(instance.id);
  expect(retried.status).toBe("running");
  expect(retried.error).toBeNull();
  await drain();

  // Resumed at review, re-applied the signal, reached boom again, failed again.
  const again = await engine.getInstance(instance.id);
  expect(again.status).toBe("failed");
  expect(await count(instance.id, "process.retry")).toBe(1);
  expect(await count(instance.id, "signal")).toBe(2);
  expect(
    await db.processEvent.count({
      where: { instanceId: instance.id, type: "activity.start", elementId: "boom" },
    }),
  ).toBe(2);
});

test("only a failed instance can be retried", async () => {
  const { id } = await engine.deploy("retry-running", hello);
  const instance = await engine.start(id, {});
  await expect(engine.retry(instance.id)).rejects.toThrow(/only a failed instance/);
});
