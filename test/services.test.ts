import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Code, ConnectError, createClient, type ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter, createConnectTransport } from "@connectrpc/connect-node";
import { disconnectPrisma, prisma } from "../src/db/client.js";
import { ProcessEngine } from "../src/engine/process-engine.js";
import { ServiceRegistry } from "../src/engine/registry.js";
import { applyTemplates, serviceTemplates, TEMPLATE_SCHEMA } from "../src/engine/templates.js";
import { exportTemplates } from "../src/commands/templates.js";
import { Worker } from "../src/engine/worker.js";
import { RegistryService } from "../src/gen/struna/v1/registry_pb.js";
import { startServer, type RunningServer } from "../src/server/server.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const db = prisma(TEST_DATABASE_URL);
const engine = new ProcessEngine(db);

/** The demo API's descriptor set, built by buf from examples/services/proto. */
let descriptorSet: Uint8Array;
/** A stand-in for a team's real service, built from that same descriptor set. */
let demo: { url: string; headers: Record<string, string>[]; close(): Promise<void> };

async function startDemo(): Promise<typeof demo> {
  const registry = ServiceRegistry.parse(descriptorSet);
  const math = registry.getService("acme.demo.v1.MathService")!;
  const greeter = registry.getService("acme.demo.v1.GreeterService")!;
  const headers: Record<string, string>[] = [];
  const seen = (context: { requestHeader: Headers }) =>
    headers.push({
      instance: context.requestHeader.get("struna-instance-id") ?? "",
      element: context.requestHeader.get("struna-element-id") ?? "",
    });
  const routes = (router: ConnectRouter) => {
    router.service(math, {
      add: (req: { a: number; b: number }, context: { requestHeader: Headers }) => {
        seen(context);
        return { sum: req.a + req.b };
      },
      divide: (req: { a: number; b: number }) => {
        // How a service reports a failure: a Connect error with a code.
        if (req.b === 0) throw new ConnectError("division is closed today", Code.FailedPrecondition);
        return { quotient: req.a / req.b };
      },
    } as never);
    router.service(greeter, {
      greet: (req: { name: string; locale: string }) => ({
        message: `${req.locale === "de" ? "Hallo" : "Hello"}, ${req.name}!`,
      }),
      echo: (req: unknown) => ({ request: req }),
    } as never);
  };
  const server = http.createServer(connectNodeAdapter({ routes }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    headers,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "struna-services-"));
  const out = path.join(dir, "demo.binpb");
  execFileSync("npx", ["--no-install", "buf", "build", "examples/services/proto", "-o", out], { stdio: "ignore" });
  descriptorSet = readFileSync(out);
  demo = await startDemo();
});

afterAll(async () => {
  await demo?.close();
  await disconnectPrisma();
});

async function drain(): Promise<void> {
  const worker = new Worker(db, { registry: engine.registry });
  while ((await worker.tick()).more);
}

/**
 * A process of Zeebe service tasks: each calls `method` (its task definition
 * type) with `params` as `zeebe:input`s, target → source.
 */
function callingProcess(
  id: string,
  tasks: {
    id: string;
    method?: string;
    params?: Record<string, string>;
    /** target → source, as `zeebe:output`s. */
    outputs?: Record<string, string>;
    resultVariable?: string;
  }[],
) {
  const flows: string[] = [];
  const nodes = tasks.map((task, i) => {
    const params = [
      ...Object.entries(task.params ?? {}).map(
        ([target, source]) => `<zeebe:input source="${source.replace(/"/g, "&quot;")}" target="${target}" />`,
      ),
      ...Object.entries(task.outputs ?? {}).map(
        ([target, source]) => `<zeebe:output source="${source}" target="${target}" />`,
      ),
    ].join("");
    const headers =
      task.resultVariable === undefined
        ? ""
        : `<zeebe:taskHeaders><zeebe:header key="resultVariable" value="${task.resultVariable}" /></zeebe:taskHeaders>`;
    flows.push(`<sequenceFlow id="f${i}" sourceRef="${i === 0 ? "start" : tasks[i - 1]!.id}" targetRef="${task.id}" />`);
    const definition = task.method === undefined ? "" : `<zeebe:taskDefinition type="${task.method}" />`;
    return `<serviceTask id="${task.id}"><extensionElements>${definition}${headers}<zeebe:ioMapping>${params}</zeebe:ioMapping></extensionElements></serviceTask>`;
  });
  flows.push(`<sequenceFlow id="fend" sourceRef="${tasks.at(-1)!.id}" targetRef="end" />`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             id="${id}-defs" targetNamespace="http://struna.io/bpmn">
  <process id="${id}" isExecutable="true">
    <startEvent id="start" />${nodes.join("")}<endEvent id="end" />${flows.join("")}
  </process>
</definitions>`;
}

test("registers every service in a descriptor set, or only the named ones", async () => {
  const all = await engine.registry.add(descriptorSet, `${demo.url}/`);
  expect(all.map((s) => s.name)).toEqual(["acme.demo.v1.GreeterService", "acme.demo.v1.MathService"]);
  const math = all.find((s) => s.name === "acme.demo.v1.MathService")!;
  expect(math.baseUrl).toBe(demo.url);
  expect(math.protocol).toBe("connect");
  expect(math.methods.map((m) => m.path)).toEqual([
    "acme.demo.v1.MathService/Add",
    "acme.demo.v1.MathService/Divide",
  ]);

  // Only one of them, somewhere else: the other keeps its registration.
  const moved = await engine.registry.add(descriptorSet, "https://math.example", {
    services: ["acme.demo.v1.MathService"],
    protocol: "grpc",
  });
  expect(moved).toHaveLength(1);
  const listed = await engine.registry.list();
  expect(listed.find((s) => s.name === "acme.demo.v1.MathService")).toMatchObject({
    baseUrl: "https://math.example",
    protocol: "grpc",
  });
  expect(listed.find((s) => s.name === "acme.demo.v1.GreeterService")?.baseUrl).toBe(demo.url);
  // Superseded descriptor sets nobody points at are dropped.
  expect(await db.descriptorSet.count()).toBe(2);

  await engine.registry.remove("acme.demo.v1.MathService");
  expect((await engine.registry.list()).map((s) => s.name)).toEqual(["acme.demo.v1.GreeterService"]);
  await expect(engine.registry.remove("acme.demo.v1.MathService")).rejects.toThrow(/no service/);
});

test("refuses what it cannot use", async () => {
  await expect(engine.registry.add(descriptorSet, "not a url")).rejects.toThrow(/not a URL/);
  await expect(engine.registry.add(descriptorSet, "ftp://x")).rejects.toThrow(/http or https/);
  await expect(engine.registry.add(descriptorSet, demo.url, { protocol: "soap" })).rejects.toThrow(/protocol/);
  await expect(
    engine.registry.add(descriptorSet, demo.url, { services: ["acme.demo.v1.Nope"] }),
  ).rejects.toThrow(/has no acme.demo.v1.Nope; it describes acme.demo.v1.GreeterService/);
  await expect(engine.registry.add(new Uint8Array([1, 2, 3]), demo.url)).rejects.toThrow(
    /not a usable descriptor set/,
  );
});

test("checks service tasks when a process is deployed", async () => {
  await engine.registry.add(descriptorSet, demo.url);

  await expect(engine.deploy("no-method", callingProcess("no-method", [{ id: "call" }]))).rejects.toThrow(
    /service task call: set <zeebe:taskDefinition/,
  );
  await expect(
    engine.deploy("unregistered", callingProcess("unregistered", [{ id: "call", method: "acme.x.v1.Nope/Do" }])),
  ).rejects.toThrow(/service task call: service acme.x.v1.Nope is not registered/);
  await expect(
    engine.deploy("no-such-method", callingProcess("no-such-method", [{ id: "call", method: "acme.demo.v1.MathService/Pow" }])),
  ).rejects.toThrow(/MathService has no method Pow; it has Add, Divide/);
  await expect(
    engine.deploy(
      "bad-field",
      callingProcess("bad-field", [{ id: "call", method: "acme.demo.v1.MathService/Add", params: { c: "1" } }]),
    ),
  ).rejects.toThrow(/acme.demo.v1.AddRequest has no field "c"/);
  await expect(
    engine.deploy(
      "bad-nested",
      callingProcess("bad-nested", [
        { id: "call", method: "acme.demo.v1.GreeterService/Echo", params: { "recipient.phone": "1" } },
      ]),
    ),
  ).rejects.toThrow(/has no field "recipient.phone"/);
});

test("service tasks call registered methods; responses become task results", async () => {
  await engine.registry.add(descriptorSet, demo.url);
  const source = callingProcess("calls", [
    { id: "add", method: "acme.demo.v1.MathService/Add", params: { a: "2", b: "=b" }, outputs: { total: "=sum" } },
    {
      id: "greet",
      method: "acme.demo.v1.GreeterService/Greet",
      params: { name: "=who", locale: "de" },
    },
    {
      id: "echo",
      method: "acme.demo.v1.GreeterService/Echo",
      params: {
        "recipient.name": "Ann",
        "recipient.email_address": "ann@example.com",
        tags: '["loc","de"]',
        // A FEEL context becomes the Struct; a literal JSON array the list.
        metadata: "={sum: b}",
        urgent: "true",
      },
      resultVariable: "echoed",
    },
  ]);
  const { id } = await engine.deploy("calls", source);
  const instance = await engine.start(id, { b: 40, who: "Welt" });
  await drain();

  const done = await engine.getInstance(instance.id);
  expect(done.error).toBeNull();
  expect(done.status).toBe("completed");
  // Like connectors: a response is kept only where mapped — add's sum as
  // total, echo's whole response as echoed — and greet's, unmapped, is not.
  expect(done.variables).toEqual({
    b: 40,
    who: "Welt",
    total: 42,
    echoed: {
      request: {
        recipient: { name: "Ann", emailAddress: "ann@example.com" },
        tags: ["loc", "de"],
        metadata: { sum: 40 },
        urgent: true,
      },
    },
  });
  // The unmapped response is still the step's recorded result.
  const [greetRun] = await engine.elementRuns(instance.id, "greet");
  expect(greetRun?.output).toEqual({ message: "Hallo, Welt!" });
  expect(greetRun?.outputs).toEqual([]);
  // The service can tell which run and step called it.
  expect(demo.headers.at(-1)).toEqual({ instance: instance.id, element: "add" });
});

test("a failing method fails the instance, naming the method", async () => {
  await engine.registry.add(descriptorSet, demo.url);
  const { id } = await engine.deploy(
    "divides",
    callingProcess("divides", [
      { id: "divide", method: "acme.demo.v1.MathService/Divide", params: { a: "1", b: "0" } },
    ]),
  );
  const instance = await engine.start(id, {});
  await drain();

  const failed = await engine.getInstance(instance.id);
  expect(failed.status).toBe("failed");
  expect(failed.error).toBe(
    "acme.demo.v1.MathService/Divide failed: [failed_precondition] division is closed today",
  );
});

test("the registry RPC is off without an admin token, and guarded with one", async () => {
  const servers: RunningServer[] = [];
  try {
    for (const adminToken of [undefined, "s3cret"]) {
      servers.push(
        await startServer({
          host: "127.0.0.1",
          port: 0,
          databaseUrl: TEST_DATABASE_URL,
          worker: false,
          ...(adminToken === undefined ? {} : { adminToken }),
        }),
      );
    }
    const [closed, guarded] = servers.map((s) =>
      createClient(RegistryService, createConnectTransport({ baseUrl: s.url, httpVersion: "1.1" })),
    );
    await expect(closed!.listServices({})).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(guarded!.listServices({})).rejects.toMatchObject({ code: Code.Unauthenticated });

    const auth = { headers: { authorization: "Bearer s3cret" } };
    const added = await guarded!.addServices(
      { descriptorSet, baseUrl: demo.url, services: ["acme.demo.v1.GreeterService"] },
      auth,
    );
    expect(added.services.map((s) => s.name)).toEqual(["acme.demo.v1.GreeterService"]);
    expect(added.services[0]?.methods.map((m) => m.path)).toContain("acme.demo.v1.GreeterService/Greet");
    const listed = await guarded!.listServices({}, auth);
    expect(listed.services.map((s) => s.name)).toContain("acme.demo.v1.GreeterService");
  } finally {
    // Servers share the Prisma singleton; closing disconnects it for the rest.
    for (const server of servers.reverse()) await server.close().catch(() => undefined);
  }
});

test("the inspector shows what a service task calls and what came back", async () => {
  await engine.registry.add(descriptorSet, demo.url);
  const server = await startServer({ host: "127.0.0.1", port: 0, databaseUrl: TEST_DATABASE_URL, worker: false });
  try {
    const { id } = await engine.deploy(
      "inspected",
      callingProcess("inspected", [
        { id: "add", method: "acme.demo.v1.MathService/Add", params: { a: "2", b: "=b" } },
        {
          id: "both",
          method: "acme.demo.v1.MathService/Add",
          params: { a: "1", b: "=b" },
          outputs: { total: "=sum" },
          resultVariable: "whole",
        },
      ]),
    );
    const instance = await engine.start(id, { b: 40 });
    await drain();

    const panel = await (await fetch(`${server.url}/instances/${instance.id}/elements/add`)).text();
    expect(panel).toContain("acme.demo.v1.MathService/Add");
    expect(panel).toContain("=b");
    expect(panel).toMatch(/Result[\s\S]*&quot;sum&quot;: 42/);
    // Operate-style: each input mapping with the value it evaluated to.
    expect(panel).toMatch(/Input mappings[\s\S]*<code>b<\/code>[\s\S]*=b[\s\S]*<code>40<\/code>/);
    // Nothing mapped: the response is not kept, and the panel says why.
    expect(panel).toMatch(/Output mappings<\/h4>\s*<p class="faint unmapped">None — like a Camunda connector/);
    expect(panel).not.toContain("result.sum");

    // With an output mapping, the result variable stays in the step, and the panel says so.
    const both = await (await fetch(`${server.url}/instances/${instance.id}/elements/both`)).text();
    expect(both).toMatch(/Output mappings<\/h4>[\s\S]*<code>total<\/code>[\s\S]*=sum[\s\S]*<code>41<\/code>/);
    expect(both).toMatch(/Result variable <code>whole<\/code> holds the whole result — it stays in the step/);
  } finally {
    await server.close();
  }
});

test("a failed call repeats alone on retry: finished calls are not made again", async () => {
  await engine.registry.add(descriptorSet, demo.url);
  const { id } = await engine.deploy(
    "checkpointed",
    callingProcess("checkpointed", [
      { id: "first", method: "acme.demo.v1.MathService/Add", params: { a: "1", b: "2" }, outputs: { one: "=sum" } },
      { id: "second", method: "acme.demo.v1.MathService/Add", params: { a: "=one", b: "10" }, outputs: { two: "=sum" } },
      // b = 0: the demo service refuses, so this step fails every time.
      { id: "third", method: "acme.demo.v1.MathService/Divide", params: { a: "=two", b: "0" } },
    ]),
  );
  const instance = await engine.start(id, {});
  await drain();

  const failed = await engine.getInstance(instance.id);
  expect(failed.status).toBe("failed");
  // Saved after the second call: what it wrote is kept, not thrown away with the run.
  expect(failed.variables).toMatchObject({ one: 3, two: 13 });

  await engine.retry(instance.id);
  await drain();
  expect((await engine.getInstance(instance.id)).status).toBe("failed");

  const calls = demo.headers.filter((h) => h.instance === instance.id).map((h) => h.element);
  expect(calls).toEqual(["first", "second"]);
});

test("examples/math-demo.bpmn runs against the demo services", async () => {
  await engine.registry.add(descriptorSet, demo.url);
  const { id } = await engine.deploy("math-demo", readFileSync("examples/math-demo.bpmn", "utf8"));

  const big = await engine.start(id, { a: 30, b: 12, name: "Welt", locale: "de" });
  const small = await engine.start(id, { a: 1, b: 2, name: "Welt", locale: "de" });
  await drain();

  const done = await engine.getInstance(big.id);
  expect(done.status).toBe("completed");
  // One of each Camunda 8 way: output mappings (sum, half), a resultVariable
  // header (greeting), and a FEEL script's resultVariable (summary).
  expect(done.variables).toEqual({
    a: 30,
    b: 12,
    name: "Welt",
    locale: "de",
    sum: 42,
    half: 21,
    greeting: { message: "Hallo, Welt!" },
    summary: "Hallo, Welt! 30 + 12 = 42, half of it is 21.",
  });
  // (1 + 2) / 2 = 1.5 is not over 10: no greeting.
  const skipped = await engine.getInstance(small.id);
  expect(skipped.status).toBe("completed");
  expect(skipped.variables).not.toHaveProperty("greeting");
  expect(skipped.variables).not.toHaveProperty("summary");
});

// --- Editor templates and icons -------------------------------------------

test("templates offer each method with the service's icon and its request fields", async () => {
  await engine.registry.add(descriptorSet, demo.url);
  const described = await engine.registry.describe();
  const math = described.find((d) => d.service.name === "acme.demo.v1.MathService")!;
  const greeter = described.find((d) => d.service.name === "acme.demo.v1.GreeterService")!;

  const mathTemplates = serviceTemplates(math.service, math.desc);
  expect(mathTemplates.map((t) => t.name)).toEqual(["Math › Add", "Math › Divide"]);
  const add = mathTemplates[0]!;
  expect(add.id).toBe("acme.demo.v1.MathService/Add");
  expect(add.appliesTo).toContain("bpmn:ServiceTask");
  expect(add.icon.contents).toMatch(/^data:image\/svg\+xml;base64,/);
  // One icon per service: every method's template carries the same one.
  expect(new Set(mathTemplates.map((t) => t.icon.contents)).size).toBe(1);
  // Methods of one service share a category in the editor's picker.
  expect(add.category).toEqual({ id: "acme.demo.v1.MathService", name: "Math" });
  expect(add.properties[0]).toEqual({
    type: "Hidden",
    value: "acme.demo.v1.MathService/Add",
    binding: { type: "zeebe:taskDefinition", property: "type" },
  });
  const request = add.properties.filter((p) => p.group === "request");
  expect(request.map((p) => [p.binding.type, p.binding.name, p.type, p.feel, p.optional])).toEqual([
    ["zeebe:input", "a", "String", "optional", true],
    ["zeebe:input", "b", "String", "optional", true],
  ]);
  // Where the response goes, as Camunda's connector templates offer it.
  // Where the response goes: an output mapping per response field (its value
  // is the variable to write), then the connector-style result fields.
  const output = add.properties.filter((p) => p.group === "output");
  expect(output.map((p) => [p.label, p.binding.type, p.binding.source ?? p.binding.key, p.optional])).toEqual([
    ["Map sum to", "zeebe:output", "=sum", true],
    ["Result variable", "zeebe:taskHeader", "resultVariable", undefined],
    ["Result expression", "zeebe:taskHeader", "resultExpression", undefined],
  ]);
  // Nested response fields are offered by their dotted path.
  const echoOut = serviceTemplates(greeter.service, greeter.desc)
    .find((t) => t.name === "Greeter › Echo")!
    .properties.filter((p) => p.binding.type === "zeebe:output")
    .map((p) => p.binding.source);
  expect(echoOut).toContain("=request.recipient.email_address");

  // Connector-style wording: readable labels, the proto name kept in the description.
  expect(add.groups).toEqual([
    { id: "request", label: "Request" },
    { id: "output", label: "Output mapping" },
  ]);
  expect(request[0]).toMatchObject({ label: "A", description: "int32 · a" });
  expect(output.find((p) => p.label === "Result expression")?.description).toContain("={sum: response.sum}");

  const echo = serviceTemplates(greeter.service, greeter.desc).find((t) => t.name === "Greeter › Echo")!;
  expect(echo.properties.find((p) => p.binding.name === "recipient.email_address")).toMatchObject({
    label: "Recipient › Email address",
    description: "string · recipient.email_address",
  });
  expect(echo.properties.filter((p) => p.group === "request").map((p) => [p.binding.name, p.type])).toEqual([
    ["recipient.name", "String"],
    ["recipient.email_address", "String"],
    ["tags", "Text"],
    ["metadata", "Text"],
    ["urgent", "String"],
  ]);
});

test("export writes one file per service and removes files for services gone", async () => {
  await engine.registry.add(descriptorSet, demo.url);
  const out = mkdtempSync(path.join(tmpdir(), "struna-templates-"));
  writeFileSync(path.join(out, "struna-acme.gone.v1.OldService.json"), "[]");
  writeFileSync(path.join(out, "someone-elses.json"), "[]");

  const written = await exportTemplates(engine.registry, out);

  expect(written.map((f) => path.basename(f)).sort()).toEqual([
    "struna-acme.demo.v1.GreeterService.json",
    "struna-acme.demo.v1.MathService.json",
  ]);
  expect(readdirSync(out).sort()).toEqual([
    "someone-elses.json",
    "struna-acme.demo.v1.GreeterService.json",
    "struna-acme.demo.v1.MathService.json",
  ]);
  const math = JSON.parse(readFileSync(path.join(out, "struna-acme.demo.v1.MathService.json"), "utf8")) as {
    $schema: string;
    name: string;
  }[];
  expect(math[0]?.$schema).toBe(TEMPLATE_SCHEMA);
});

test("a service's title and icon can be set, and reset to the defaults", async () => {
  await engine.registry.add(descriptorSet, demo.url);
  const icon = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;

  const set = await engine.registry.setAppearance("acme.demo.v1.MathService", { title: "Calculator", icon });
  expect(set).toMatchObject({ title: "Calculator", icon, customIcon: true });

  const reset = await engine.registry.setAppearance("acme.demo.v1.MathService", { title: "", icon: "" });
  expect(reset).toMatchObject({ title: "Math", customIcon: false });
  expect(reset.icon).toMatch(/^data:image\/svg\+xml;base64,/);

  await expect(
    engine.registry.setAppearance("acme.demo.v1.MathService", { icon: "https://example.com/x.svg" }),
  ).rejects.toThrow(/data:image/);
  await expect(engine.registry.setAppearance("acme.demo.v1.Nope", { title: "x" })).rejects.toThrow(/no service/);
});

test("a task set up from a template runs: FEEL and literals; a blank field writes no input", async () => {
  await engine.registry.add(descriptorSet, demo.url);
  // What a Camunda 8 editor writes after picking "Math › Add", entering
  // "=x * 2" for a and leaving b blank (optional fields write nothing).
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
             id="templated-defs" targetNamespace="http://struna.io/bpmn">
  <process id="templated" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="add" />
    <serviceTask id="add" zeebe:modelerTemplate="acme.demo.v1.MathService/Add" zeebe:modelerTemplateVersion="1"
                 zeebe:modelerTemplateIcon="data:image/svg+xml;base64,PHN2Zy8+">
      <extensionElements>
        <zeebe:taskDefinition type="acme.demo.v1.MathService/Add" />
        <zeebe:ioMapping>
          <zeebe:input source="=x * 2" target="a" />
          <zeebe:output source="=sum" target="sum" />
        </zeebe:ioMapping>
      </extensionElements>
    </serviceTask>
    <sequenceFlow id="f2" sourceRef="add" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;
  const { id } = await engine.deploy("templated", source);
  const instance = await engine.start(id, { x: 21 });
  await drain();

  const done = await engine.getInstance(instance.id);
  expect(done.error).toBeNull();
  // b was never set: it stays at its default, 0.
  expect(done.variables).toMatchObject({ sum: 42 });
});

test("FEEL that does not parse fails the deploy; a missing variable fails the run, named", async () => {
  await engine.registry.add(descriptorSet, demo.url);
  await expect(
    engine.deploy(
      "bad-feel",
      callingProcess("bad-feel", [{ id: "add", method: "acme.demo.v1.MathService/Add", params: { a: "=1 +" } }]),
    ),
  ).rejects.toThrow(/add: input "a" is not valid FEEL/);

  const { id } = await engine.deploy(
    "missing-var",
    callingProcess("missing-var", [{ id: "add", method: "acme.demo.v1.MathService/Add", params: { a: "=nothing" } }]),
  );
  const instance = await engine.start(id, {});
  await drain();
  const failed = await engine.getInstance(instance.id);
  expect(failed.status).toBe("failed");
  expect(failed.error).toMatch(/FEEL "nothing"/);
});

test("diagrams show each service task's registered icon", async () => {
  await engine.registry.add(descriptorSet, demo.url);
  const icon = `data:image/svg+xml;base64,${Buffer.from("<svg id='math'/>").toString("base64")}`;
  await engine.registry.setAppearance("acme.demo.v1.MathService", { icon });
  const server = await startServer({ host: "127.0.0.1", port: 0, databaseUrl: TEST_DATABASE_URL, worker: false });
  try {
    const { id } = await engine.deploy(
      "iconic",
      callingProcess("iconic", [{ id: "add", method: "acme.demo.v1.MathService/Add", params: { a: "1", b: "2" } }]),
    );
    const page = await (await fetch(`${server.url}/definitions/${id}`)).text();
    const icons = page.match(/data-icons="([^"]*)"/)?.[1]?.replace(/&quot;/g, '"');
    expect(JSON.parse(icons ?? "{}")).toEqual({ add: icon });
  } finally {
    await server.close();
    await engine.registry.setAppearance("acme.demo.v1.MathService", { icon: "" });
  }
});

test("apply links service tasks to their templates, in place and repeatably", () => {
  const xml = `<definitions xmlns:zeebe="http://camunda.org/schema/zeebe/1.0">
  <!-- keep me -->
  <serviceTask id="add" name="Add">
    <extensionElements><zeebe:taskDefinition type="acme.demo.v1.MathService/Add" /></extensionElements>
  </serviceTask>
  <serviceTask id="other" zeebe:modelerTemplate="old" zeebe:modelerTemplateVersion="7" zeebe:modelerTemplateIcon="data:old"/>
  <serviceTask id="unknown" />
</definitions>`;
  const methods = { add: "acme.demo.v1.MathService/Add", other: "acme.demo.v1.MathService/Divide", unknown: "acme.x.v1.Nope/Do" };
  const icons = {
    "acme.demo.v1.MathService/Add": "data:image/svg+xml;base64,QQ==",
    "acme.demo.v1.MathService/Divide": "data:image/svg+xml;base64,RA==",
  };

  const once = applyTemplates(xml, methods, icons);
  expect(once.applied).toEqual(["add", "other"]);
  expect(once.xml).toContain("<!-- keep me -->");
  expect(once.xml).toContain(
    '<serviceTask id="add" name="Add" zeebe:modelerTemplate="acme.demo.v1.MathService/Add" zeebe:modelerTemplateVersion="1" zeebe:modelerTemplateIcon="data:image/svg+xml;base64,QQ==">',
  );
  // An older link is replaced, not duplicated; a self-closing tag stays one.
  expect(once.xml).toContain(
    '<serviceTask id="other" zeebe:modelerTemplate="acme.demo.v1.MathService/Divide" zeebe:modelerTemplateVersion="1" zeebe:modelerTemplateIcon="data:image/svg+xml;base64,RA=="/>',
  );
  // Unregistered services are left alone.
  expect(once.xml).toContain('<serviceTask id="unknown" />');
  expect(applyTemplates(once.xml, methods, icons).xml).toBe(once.xml);
});

// --- Services pages --------------------------------------------------------

test("the Services tab lists registered services; a service page shows methods, usage and calls", async () => {
  await engine.registry.add(descriptorSet, demo.url);
  await engine.registry.setAppearance("acme.demo.v1.MathService", { title: "", icon: "" });
  const server = await startServer({ host: "127.0.0.1", port: 0, databaseUrl: TEST_DATABASE_URL, worker: false });
  try {
    // Something that calls the service: one good call, one failing one.
    const { id } = await engine.deploy(
      "uses-math",
      callingProcess("uses-math", [
        { id: "sum", method: "acme.demo.v1.MathService/Add", params: { a: "1", b: "2" }, outputs: { sum: "=sum" } },
        { id: "split", method: "acme.demo.v1.MathService/Divide", params: { a: "=sum", b: "=zero" } },
      ]),
    );
    const instance = await engine.start(id, { zero: 0 });
    await drain();
    expect((await engine.getInstance(instance.id)).status).toBe("failed");

    const list = await (await fetch(`${server.url}/services`)).text();
    expect(list).toMatch(/<a class="tab" href="\/services" aria-current="page">Services<\/a>/);
    expect(list).toContain('href="/services/acme.demo.v1.MathService"');
    expect(list).toContain("acme.demo.v1.GreeterService");
    expect(list).toMatch(/<img class="service-icon inline" src="data:image\/svg\+xml;base64,/);

    const page = await (await fetch(`${server.url}/services/acme.demo.v1.MathService`)).text();
    expect(page).toContain("<h1>Math</h1>");
    expect(page).toContain(demo.url);
    expect(page).toContain('id="method-Add"');
    expect(page).toContain("acme.demo.v1.AddRequest → acme.demo.v1.AddResponse");
    expect(page).toMatch(/<code>a<\/code><\/td>\s*<td class="mono faint">int32/);
    // Where it is used, and how the calls went.
    expect(page).toMatch(/Used by[\s\S]*uses-math v1<\/a> <code class="faint">sum<\/code>/);
    expect(page).toMatch(/badge completed">ok[\s\S]*<code>sum<\/code>/);
    expect(page).toMatch(/badge failed">failed[\s\S]*<code>split<\/code>/);
    // One command per line.
    expect(page).toContain(
      `--service acme.demo.v1.MathService\nnpx struna templates export\nnpx struna services remove acme.demo.v1.MathService`,
    );

    expect((await fetch(`${server.url}/services/acme.demo.v1.Nope`)).status).toBe(404);

    // The inspector links a service task to its service's page.
    const panel = await (await fetch(`${server.url}/instances/${instance.id}/elements/sum`)).text();
    expect(panel).toContain('href="/services/acme.demo.v1.MathService#method-Add"');
  } finally {
    await server.close();
  }
});
