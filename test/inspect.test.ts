import { afterAll, expect, test } from "vitest";
import { disconnectPrisma, prisma } from "../src/db/client.js";
import {
  DEFAULT_PAYLOAD_POLICY,
  parseRedactKeys,
  REDACTED,
  redact,
  sanitize,
} from "../src/engine/payload.js";
import { ProcessEngine } from "../src/engine/process-engine.js";
import { Worker } from "../src/engine/worker.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

// start → calc (script sets `total`) → review (user task) → end
const scripted = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="scripted-defs"
             targetNamespace="http://struna.io/bpmn">
  <process id="scripted" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="calc" />
    <scriptTask id="calc" scriptFormat="javascript">
      <script>environment.variables.total = 40 + 2; next(null, { computed: true });</script>
    </scriptTask>
    <sequenceFlow id="f2" sourceRef="calc" targetRef="review" />
    <userTask id="review" />
    <sequenceFlow id="f3" sourceRef="review" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

// start → bump (n += 1) → gateway: back to bump while n < 3, else end
const looping = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             id="loop-defs" targetNamespace="http://struna.io/bpmn">
  <process id="loop" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="bump" />
    <scriptTask id="bump" scriptFormat="javascript">
      <script>environment.variables.n = (environment.variables.n || 0) + 1; next();</script>
    </scriptTask>
    <sequenceFlow id="f2" sourceRef="bump" targetRef="again" />
    <exclusiveGateway id="again" default="done" />
    <sequenceFlow id="more" sourceRef="again" targetRef="bump">
      <conditionExpression xsi:type="tFormalExpression" language="javascript">next(null, environment.variables.n &lt; 3)</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="done" sourceRef="again" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

const db = prisma(TEST_DATABASE_URL);
const engine = new ProcessEngine(db);
const worker = new Worker(db);

afterAll(async () => {
  await disconnectPrisma();
});

async function drain(): Promise<void> {
  while ((await worker.tick()).more);
}

test("masks sensitive keys at any depth, by fragment", () => {
  const masked = redact(
    {
      user: "vh",
      password: "hunter2",
      nested: { accessToken: "abc", "X-Api-Key": "k", list: [{ client_secret: "s" }] },
    },
    DEFAULT_PAYLOAD_POLICY,
  );
  expect(masked).toEqual({
    user: "vh",
    password: REDACTED,
    nested: { accessToken: REDACTED, "X-Api-Key": REDACTED, list: [{ client_secret: REDACTED }] },
  });
});

test("reads the redaction list from the environment, defaulting when empty", () => {
  expect(parseRedactKeys(undefined)).toEqual(DEFAULT_PAYLOAD_POLICY.redactKeys);
  expect(parseRedactKeys(" ")).toEqual(DEFAULT_PAYLOAD_POLICY.redactKeys);
  expect(parseRedactKeys("iban, ssn ,")).toEqual(["iban", "ssn"]);
});

test("replaces a payload over the size cap with a marker", () => {
  const big = sanitize({ blob: "x".repeat(100) }, { redactKeys: [], maxBytes: 50 });
  expect(big).toMatchObject({ truncated: true });
  expect(sanitize({ ok: 1 }, { redactKeys: [], maxBytes: 50 })).toEqual({ ok: 1 });
});

test("a completed instance keeps the variables its scripts set", async () => {
  const { id } = await engine.deploy("scripted-complete", scripted);
  const instance = await engine.start(id, { requester: "vh" });
  await engine.signal(instance.id, "review", {});
  await drain();

  const done = await engine.getInstance(instance.id);
  expect(done.status).toBe("completed");
  expect(done.variables).toMatchObject({ requester: "vh", total: 42 });
});

test("records outputs, signals and variable snapshots for the inspector", async () => {
  const { id } = await engine.deploy("scripted-inspect", scripted);
  const instance = await engine.start(id, { requester: "vh" });
  await drain();

  // Parked on review: the instance row already carries the script's variable.
  expect((await engine.getInstance(instance.id)).variables).toMatchObject({ total: 42 });

  const [calc] = await engine.elementRuns(instance.id, "calc");
  expect(calc?.output).toEqual({ computed: true });
  expect(calc?.variables).toMatchObject({ variables: { requester: "vh", total: 42 } });

  const [open] = await engine.elementRuns(instance.id, "review");
  expect(open?.endedAt).toBeNull();
  expect(open?.waitedAt).not.toBeNull();

  await engine.signal(instance.id, "review", { approved: true, password: "hunter2" });
  await drain();

  const [review] = await engine.elementRuns(instance.id, "review");
  expect(review?.endedAt).not.toBeNull();
  expect(review?.signals.map((s) => s.payload)).toEqual([{ approved: true, password: REDACTED }]);
  expect(review?.output).toMatchObject({ approved: true, password: REDACTED });

  // The raw password never reached the log.
  const logged = await db.processEvent.findMany({ where: { instanceId: instance.id } });
  expect(JSON.stringify(logged.map((e) => e.payload))).not.toContain("hunter2");
});

test("counts and separates the runs of an element in a loop", async () => {
  const { id } = await engine.deploy("looping", looping);
  const instance = await engine.start(id, {});
  await drain();

  expect((await engine.getInstance(instance.id)).status).toBe("completed");
  const progress = await engine.elementProgress(instance.id);
  expect(progress.runs["bump"]).toBe(3);

  const runs = await engine.elementRuns(instance.id, "bump");
  expect(runs.map((run) => (run.variables as { variables: { n: number } }).variables.n)).toEqual([
    1, 2, 3,
  ]);
});
