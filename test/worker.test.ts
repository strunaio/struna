import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, expect, test } from "vitest";
import { disconnectPrisma, prisma } from "../src/db/client.js";
import { ProcessEngine } from "../src/engine/process-engine.js";
import { Worker, runWorker } from "../src/engine/worker.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const source = readFileSync("examples/hello.bpmn", "utf8");

// start → 1s timer → end
const timerSource = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="timer-definitions"
             targetNamespace="http://struna.io/bpmn">
  <process id="timer" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="to-pause" sourceRef="start" targetRef="pause" />
    <intermediateCatchEvent id="pause">
      <timerEventDefinition><timeDuration>PT1S</timeDuration></timerEventDefinition>
    </intermediateCatchEvent>
    <sequenceFlow id="to-end" sourceRef="pause" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

const db = prisma(TEST_DATABASE_URL);
const engine = new ProcessEngine(db);

afterAll(async () => {
  await disconnectPrisma();
});

async function drain(worker: Worker): Promise<void> {
  while ((await worker.tick()).more);
}

test("concurrent workers run each instance exactly once", async () => {
  const { id } = await engine.deploy("contended", source);
  const ids = await Promise.all(
    Array.from({ length: 8 }, async () => (await engine.start(id, {})).id),
  );

  const workers = [new Worker(db), new Worker(db), new Worker(db)];
  await Promise.all(workers.map(drain));

  for (const instanceId of ids) {
    const starts = await db.processEvent.count({
      where: { instanceId, type: "process.start" },
    });
    expect(starts).toBe(1);
    const instance = await engine.getInstance(instanceId);
    expect(instance.status).toBe("running");
    expect(instance.lockedBy).toBeNull();
    expect(instance.runnableAt).toBeNull();
  }
});

test("a timer parks the instance until it is due", async () => {
  const { id } = await engine.deploy("timed", timerSource);
  const instance = await engine.start(id, {});
  const worker = new Worker(db);

  await drain(worker);
  const parked = await engine.getInstance(instance.id);
  expect(parked.status).toBe("running");
  expect(parked.runnableAt).not.toBeNull();
  expect(parked.runnableAt!.getTime()).toBeGreaterThan(Date.now());

  // Not due yet: nothing to claim.
  expect((await worker.tick()).processed).toBe(0);

  await sleep(parked.runnableAt!.getTime() - Date.now() + 50);
  await drain(worker);
  expect((await engine.getInstance(instance.id)).status).toBe("completed");
});

test("an expired lease is reclaimed by another worker", async () => {
  const { id } = await engine.deploy("abandoned", source);
  const instance = await engine.start(id, {});

  // A worker that claimed it and died.
  await db.processInstance.update({
    where: { id: instance.id },
    data: { lockedBy: "dead-worker", lockedUntil: new Date(Date.now() - 1_000) },
  });

  await drain(new Worker(db));
  const after = await engine.getInstance(instance.id);
  expect(after.status).toBe("running");
  expect(after.lockedBy).toBeNull();
});

test("a live lease is left alone", async () => {
  const { id } = await engine.deploy("held", source);
  const instance = await engine.start(id, {});

  await db.processInstance.update({
    where: { id: instance.id },
    data: { lockedBy: "busy-worker", lockedUntil: new Date(Date.now() + 60_000) },
  });

  await drain(new Worker(db));
  const after = await engine.getInstance(instance.id);
  expect(after.status).toBe("pending");
  expect(after.lockedBy).toBe("busy-worker");

  await db.processInstance.update({
    where: { id: instance.id },
    data: { lockedBy: null, lockedUntil: null },
  });
});

test("runWorker drains the queue until aborted", async () => {
  const { id } = await engine.deploy("looped", source);
  const instance = await engine.start(id, {});
  await engine.signal(instance.id, "review", {});

  const stop = new AbortController();
  const loop = runWorker(new Worker(db), { signal: stop.signal, idleMs: 20 });

  for (let i = 0; i < 100; i++) {
    if ((await engine.getInstance(instance.id)).status === "completed") break;
    await sleep(20);
  }
  stop.abort();
  await loop;

  expect((await engine.getInstance(instance.id)).status).toBe("completed");
});

test("definitions and instances get time-ordered UUIDv7 ids", async () => {
  const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const { id } = await engine.deploy("ids", source);
  const first = await engine.start(id, {});
  await sleep(2);
  const second = await engine.start(id, {});

  expect(id).toMatch(UUID_V7);
  expect(first.id).toMatch(UUID_V7);
  // The canonical string sorts in creation order.
  expect(first.id < second.id).toBe(true);
});
