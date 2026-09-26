import { readFileSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { disconnectPrisma, prisma } from "../src/db/client.js";
import { applyResult } from "../src/engine/bpmn-extensions.js";
import { ProcessEngine } from "../src/engine/process-engine.js";
import { Worker } from "../src/engine/worker.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const db = prisma(TEST_DATABASE_URL);
const engine = new ProcessEngine(db);

afterAll(async () => {
  await disconnectPrisma();
});

async function drain(): Promise<void> {
  const worker = new Worker(db);
  while ((await worker.tick()).more);
}

const none = { outputs: [] };

test("without mappings a result merges into the variables by name", () => {
  const vars: Record<string, unknown> = { a: 1, sum: 0 };
  applyResult(vars, { sum: 42, note: "x" }, none);
  expect(vars).toEqual({ a: 1, sum: 42, note: "x" });
  // Only objects merge; a bare value needs a resultVariable.
  applyResult(vars, 7, none);
  expect(vars).toEqual({ a: 1, sum: 42, note: "x" });
});

test("output mappings write only what they map, from the result, the inputs and the process", () => {
  const vars: Record<string, unknown> = { rate: 2 };
  const written = applyResult(vars, { quotient: 21, noise: true }, {
    outputs: [
      { source: "=quotient", target: "half" },
      { source: "=quotient * rate", target: "totals.doubled" },
      { source: "=a", target: "input_a" },
      { source: "=missing", target: "empty" },
      { source: "literal", target: "tag" },
    ],
    locals: { a: 42 },
  });
  expect(vars).toEqual({ rate: 2, half: 21, totals: { doubled: 42 }, input_a: 42, empty: null, tag: "literal" });
  expect(vars).not.toHaveProperty("noise");
  expect(written).toContainEqual({ target: "half", kind: "mapping", source: "=quotient", value: 21 });
  expect(written).toContainEqual({ target: "totals.doubled", kind: "mapping", source: "=quotient * rate", value: 42 });
});

test("a connector-style task keeps nothing its rules do not map", () => {
  const vars: Record<string, unknown> = { a: 1 };
  expect(applyResult(vars, { sum: 42 }, { outputs: [], unmapped: "discard" })).toEqual([]);
  expect(vars).toEqual({ a: 1 });
  // Mapped values are still written.
  applyResult(vars, { sum: 42 }, { outputs: [{ source: "=sum", target: "total" }], unmapped: "discard" });
  expect(vars).toEqual({ a: 1, total: 42 });
});

test("each written value says how it got there", () => {
  const merged = applyResult({}, { sum: 42 }, { outputs: [] });
  expect(merged).toEqual([{ target: "sum", kind: "merged", source: "", value: 42 }]);
  const whole = applyResult({}, { sum: 42 }, { outputs: [], resultVariable: "r" });
  expect(whole).toEqual([{ target: "r", kind: "whole", source: "", value: { sum: 42 } }]);
  const shaped = applyResult({}, { sum: 42 }, { outputs: [], resultExpression: "={total: response.sum}" });
  expect(shaped).toEqual([{ target: "total", kind: "expression", source: "={total: response.sum}", value: 42 }]);
});

test("resultVariable keeps the whole result; resultExpression reshapes it", () => {
  const vars: Record<string, unknown> = {};
  applyResult(vars, { message: "hi", code: 200 }, { outputs: [], resultVariable: "greeting" });
  expect(vars).toEqual({ greeting: { message: "hi", code: 200 } });

  const shaped: Record<string, unknown> = {};
  applyResult(shaped, { message: "hi", code: 200 }, {
    outputs: [],
    resultExpression: "={text: response.message, ok: response.code = 200}",
  });
  expect(shaped).toEqual({ text: "hi", ok: true });
});

test("with output mappings, resultVariable and resultExpression stay in the step unless mapped (Zeebe)", () => {
  const rules = {
    outputs: [{ source: "=message", target: "greeting" }],
    resultVariable: "whole",
    resultExpression: "={loud: upper case(response.message)}",
    unmapped: "discard" as const,
  };
  const vars: Record<string, unknown> = {};
  const written = applyResult(vars, { message: "Hallo" }, rules);
  expect(vars).toEqual({ greeting: "Hallo" });
  expect(written).toContainEqual({ target: "loud", kind: "local", source: rules.resultExpression, value: "HALLO" });
  expect(written).toContainEqual({ target: "whole", kind: "local", source: "", value: { message: "Hallo" } });

  // An output mapping can read what they produced.
  const mapped: Record<string, unknown> = {};
  applyResult(mapped, { message: "Hallo" }, {
    ...rules,
    outputs: [...rules.outputs, { source: "=loud", target: "shout" }, { source: "=whole.message", target: "copy" }],
  });
  expect(mapped).toEqual({ greeting: "Hallo", shout: "HALLO", copy: "Hallo" });
});

test("a signal's payload follows the task's output mappings", async () => {
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             id="mapped-defs" targetNamespace="http://struna.io/bpmn">
  <process id="mapped" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="review" />
    <userTask id="review">
      <extensionElements>
        <zeebe:ioMapping><zeebe:output source="=approved" target="review_ok" /></zeebe:ioMapping>
      </extensionElements>
    </userTask>
    <sequenceFlow id="f2" sourceRef="review" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;
  const { id } = await engine.deploy("mapped", source);
  const instance = await engine.start(id, {});
  await drain();
  await engine.signal(instance.id, "review", { approved: true, comment: "fine" });
  await drain();

  const done = await engine.getInstance(instance.id);
  expect(done.variables).toEqual({ review_ok: true });
});

test("FEEL in outputs and resultExpression is checked at deploy", async () => {
  const withOutput = (extension: string) => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="d" targetNamespace="x">
  <process id="p" isExecutable="true">
    <startEvent id="s" /><sequenceFlow id="f" sourceRef="s" targetRef="t" />
    <userTask id="t"><extensionElements>${extension}</extensionElements></userTask>
  </process>
</definitions>`;
  await expect(
    engine.deploy("bad-output", withOutput('<zeebe:ioMapping><zeebe:output source="=a +" target="x" /></zeebe:ioMapping>')),
  ).rejects.toThrow(/t: output "x" is not valid FEEL/);
  await expect(
    engine.deploy(
      "bad-expression",
      withOutput('<zeebe:taskHeaders><zeebe:header key="resultExpression" value="={a:" /></zeebe:taskHeaders>'),
    ),
  ).rejects.toThrow(/t: resultExpression is not valid FEEL/);
});

test("the example processes use the Camunda 8 result rules", () => {
  const math = readFileSync("examples/math-demo.bpmn", "utf8");
  expect(math).toContain('<zeebe:output source="=quotient" target="half" />');
  expect(math).toContain('<zeebe:header key="resultVariable" value="greeting" />');
});

// --- FEEL scripts, conditions and messages ---------------------------------

const feelProcess = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             id="feel-defs" targetNamespace="http://struna.io/bpmn">
  <message id="Msg_order" name="order_arrived">
    <extensionElements><zeebe:subscription correlationKey="=order_id" /></extensionElements>
  </message>
  <process id="feel" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="wait_order" />
    <receiveTask id="wait_order" messageRef="Msg_order" />
    <sequenceFlow id="f2" sourceRef="wait_order" targetRef="total" />
    <scriptTask id="total">
      <extensionElements><zeebe:script expression="=sum(for item in items return item.price)" resultVariable="total" /></extensionElements>
    </scriptTask>
    <sequenceFlow id="f3" sourceRef="total" targetRef="big" />
    <exclusiveGateway id="big" default="small" />
    <sequenceFlow id="large" sourceRef="big" targetRef="ship_free">
      <conditionExpression xsi:type="tFormalExpression">=total &gt;= 100</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="small" sourceRef="big" targetRef="ship_paid" />
    <endEvent id="ship_free" />
    <endEvent id="ship_paid" />
  </process>
</definitions>`;

test("a receive task waits for its message; FEEL scripts and conditions run", async () => {
  const { id } = await engine.deploy("feel", feelProcess);
  for (const [items, expected] of [
    [[{ price: 60 }, { price: 70 }], "ship_free"],
    [[{ price: 5 }], "ship_paid"],
  ] as const) {
    const instance = await engine.start(id, { order_id: "o-1" });
    await drain();
    expect(await engine.waitingActivities(instance.id)).toEqual(["wait_order"]);

    // Signalled by element id; delivered as the task's message.
    await engine.signal(instance.id, "wait_order", { items });
    await drain();

    const done = await engine.getInstance(instance.id);
    expect(done.status).toBe("completed");
    const total = items.reduce((n, item) => n + item.price, 0);
    // The payload merged (without the message's id), the script's value under its resultVariable.
    expect(done.variables).toEqual({ order_id: "o-1", items, total });
    const ended = await db.processEvent.findFirst({
      where: { instanceId: instance.id, type: "activity.end", elementId: { in: ["ship_free", "ship_paid"] } },
    });
    expect(ended?.elementId).toBe(expected);
  }
});

test("FEEL conditions and scripts are checked at deploy; a zeebe:script needs a resultVariable", async () => {
  await expect(engine.deploy("bad-condition", feelProcess.replace("=total &gt;= 100", "=total &gt;="))).rejects.toThrow(
    /large: condition is not valid FEEL/,
  );
  await expect(
    engine.deploy("bad-script", feelProcess.replace("=sum(for item in items return item.price)", "=sum(")),
  ).rejects.toThrow(/total: script is not valid FEEL/);
  await expect(engine.deploy("no-result", feelProcess.replace(' resultVariable="total"', ""))).rejects.toThrow(
    /total: a zeebe:script needs a resultVariable/,
  );
});

test("a step's 'variables after' include what its result wrote", async () => {
  const { id } = await engine.deploy("after", feelProcess);
  const instance = await engine.start(id, { order_id: "o-2" });
  await drain();
  await engine.signal(instance.id, "wait_order", { items: [{ price: 7 }] });
  await drain();

  const [run] = await engine.elementRuns(instance.id, "total");
  expect(run?.outputs).toEqual([{ target: "total", kind: "whole", source: "", value: 7 }]);
  expect(run?.variables).toMatchObject({ variables: { total: 7 } });
  // Only what this step did, not what the message before it merged.
  expect(run?.changes).toEqual([{ name: "total", kind: "added", after: 7 }]);
});
