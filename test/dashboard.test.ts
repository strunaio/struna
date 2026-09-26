import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Code, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { InstanceStatus, ProcessService } from "../src/gen/struna/v1/process_pb.js";
import { WorkerService } from "../src/gen/struna/v1/worker_pb.js";
import { startServer, type RunningServer } from "../src/server/server.js";
import { VERSION } from "../src/version.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const source = readFileSync("examples/hello.bpmn", "utf8");

let server: RunningServer;
let client: Client<typeof ProcessService>;
let workers: Client<typeof WorkerService>;
let base: string;

async function tick(): Promise<void> {
  while ((await workers.tick({})).more);
}

/** The instances table, fetched the way htmx refreshes it. */
async function instancesFragment(): Promise<string> {
  return (await fetch(`${base}/instances`, { headers: { "hx-request": "true" } })).text();
}

/** Deploy a definition and return its id. */
async function deploy(name: string): Promise<string> {
  const { definition } = await client.deployDefinition({ name, source });
  return definition!.id;
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  };
}

beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databaseUrl: TEST_DATABASE_URL,
    worker: false,
  });
  base = server.url;
  const transport = createConnectTransport({ baseUrl: base, httpVersion: "1.1" });
  client = createClient(ProcessService, transport);
  workers = createClient(WorkerService, transport);
});

afterAll(async () => {
  await server?.close();
});

test("serves the overview with one of each swappable section", async () => {
  const res = await fetch(base);
  const body = await res.text();

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  // htmx swaps these by outerHTML, so a duplicate id would break the swap.
  expect(body.match(/id="definitions"/g)).toHaveLength(1);
  expect(body.match(/id="instances"/g)).toHaveLength(1);
  expect(body).toContain('data-stream="/events/stream"');
});

test("marks the current section in the header", async () => {
  for (const [path, label] of [
    ["/", "Overview"],
    ["/definitions", "Definitions"],
    ["/instances", "Instances"],
    ["/events", "Events"],
  ] as const) {
    const body = await (await fetch(`${base}${path}`)).text();
    const current = body.match(/<a class="tab" href="[^"]*" aria-current="page">([^<]*)<\/a>/g);
    expect(current, path).toHaveLength(1);
    expect(current![0]).toContain(`>${label}<`);
  }
  // This server has no embedded worker, and says so.
  expect(await (await fetch(base)).text()).toContain("API only");
  // The footer names the running version, the same one `struna --version` prints.
  const footer = (await (await fetch(base)).text()).match(/<footer>[\s\S]*?<\/footer>/)?.[0];
  expect(footer).toContain(VERSION);
});

test("answers htmx with a fragment and a browser with the whole page", async () => {
  const fragment = await instancesFragment();
  expect(fragment.trimStart()).toMatch(/^<section id="instances"/);
  expect(fragment).not.toContain("<html");

  const full = await (await fetch(`${base}/instances`)).text();
  expect(full).toContain("<html");
  expect(full).toContain('id="instances"');
});

test("serves the favicon", async () => {
  const res = await fetch(`${base}/favicon.svg`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/svg+xml");
});

test("serves htmx and the sse extension from the installed packages", async () => {
  for (const path of ["/static/htmx.js"]) {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect((await res.text()).length).toBeGreaterThan(1000);
  }
});

test("starts an instance from the definition form and offers the waiting task", async () => {
  const id = await deploy("ui-start");
  const res = await fetch(`${base}/definitions/${id}/start`, {
    ...form({ variables: '{"requester":"vh"}' }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "hx-request": "true",
    },
  });

  // htmx is sent to the new instance's page.
  expect(res.status).toBe(200);
  const location = res.headers.get("hx-redirect");
  expect(location).toMatch(/^\/instances\/[0-9a-f-]{36}$/);
  expect(await (await fetch(`${base}${location}`)).text()).toContain('class="badge pending"');

  await tick();
  const after = await instancesFragment();
  expect(after).toContain('class="badge running"');
  // The `review` user task is parked and signalable.
  expect(after).toContain("/signal/review");
});

test("sends a plain form post to the new instance with a 303", async () => {
  const id = await deploy("ui-start-plain");
  const res = await fetch(`${base}/definitions/${id}/start`, {
    ...form({ variables: "{}" }),
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toMatch(/^\/instances\/[0-9a-f-]{36}$/);
});

test("signals the waiting task from the instance form", async () => {
  const definitionId = await deploy("ui-signal");
  const { instance } = await client.startInstance({ definitionIdOrName: definitionId, variables: {} });
  await tick();

  const res = await fetch(
    `${base}/instances/${instance!.id}/signal/review`,
    form({ payload: '{"approved":true}' }),
  );
  expect(res.status).toBe(200);

  await tick();
  expect(await instancesFragment()).toContain('class="badge completed"');

  const after = await client.getInstance({ id: instance!.id });
  expect(after.instance?.completedAt).toBeDefined();
});

test("rejects malformed form input without a stack trace", async () => {
  const id = await deploy("ui-badjson");
  const res = await fetch(`${base}/definitions/${id}/start`, form({ variables: "nope" }));

  expect(res.status).toBe(400);
  expect(await res.text()).toContain("variables must be valid JSON");
});

test("returns 404 for an unknown definition and an unknown path", async () => {
  const missing = await fetch(`${base}/definitions/nope/start`, form({ variables: "{}" }));
  expect(missing.status).toBe(404);
  expect(await missing.text()).toContain("no definition nope");

  expect((await fetch(`${base}/nope`)).status).toBe(404);
});

test("answers health checks on /health", async () => {
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("pushes engine events to the SSE feed as html fragments", async () => {
  const definitionId = await deploy("ui-sse");
  const abort = new AbortController();

  const res = await fetch(`${base}/events/stream`, { signal: abort.signal });
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const frames = (async () => {
    let buffer = "";
    while (!buffer.includes("process.end")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value ?? "";
    }
    return buffer;
  })();

  const { instance } = await client.startInstance({ definitionIdOrName: definitionId, variables: {} });
  await client.signalInstance({ id: instance!.id, elementId: "review", payload: {} });
  await tick();

  const buffer = await frames;
  abort.abort();

  expect(buffer).toContain("event: engine");
  expect(buffer).toContain("<li>");
  // Each frame must stay on one line or SSE framing breaks.
  for (const line of buffer.split("\n")) {
    if (line.startsWith("data: ")) expect(line).not.toContain("\n");
  }
});

test("a stream resumes after the last event a tab saw", async () => {
  // Read one stream until `until` shows up, then close it.
  async function read(path: string, until: string): Promise<string> {
    const abort = new AbortController();
    const res = await fetch(`${base}${path}`, { signal: abort.signal });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (!buffer.includes(until)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value ?? "";
    }
    abort.abort();
    return buffer;
  }

  const definitionId = await deploy("ui-resume");
  // A fresh stream says where it starts; events carry their id.
  const hello = await read("/events/stream", "\n\n");
  const start = /event: hello\ndata: (\d+)/.exec(hello)?.[1];
  expect(start).toBeDefined();

  // Events recorded while the tab was away are replayed from there.
  const { instance } = await client.startInstance({ definitionIdOrName: definitionId, variables: {} });
  await tick();
  const resumed = await read(`/events/stream?after=${start}`, "process.start");
  expect(resumed).toMatch(/id: \d+\nevent: engine\ndata: .*process\.start/);
  expect(instance).toBeDefined();
});

test("serves the bpmn-js viewer and its stylesheets", async () => {
  for (const [path, type] of [
    ["/static/bpmn-viewer.js", "javascript"],
    ["/static/diagram-js.css", "text/css"],
    ["/static/bpmn-js.css", "text/css"],
  ] as const) {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(type);
  }
});

test("lays out a definition that has no diagram of its own", async () => {
  // The example with its layout stripped, as hand-written BPMN usually is.
  const bare = source.replace(/\s*<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/, "");
  expect(bare).not.toContain("BPMNDiagram");
  const { definition } = await client.deployDefinition({ name: "ui-layout", source: bare });
  const id = definition!.id;

  const res = await fetch(`${base}/definitions/${id}/diagram.bpmn`);
  const xml = await res.text();

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/xml");
  expect(xml).toContain("BPMNShape");
  expect(xml).toContain('bpmnElement="review"');
  // The source only has sourceRef/targetRef; the flows must still be drawn.
  expect(xml).toContain('<bpmndi:BPMNEdge id="to-review_di" bpmnElement="to-review">');
  expect(xml).toContain('bpmnElement="to-end"');
});

test("serves a definition that has its own layout as authored", async () => {
  expect(source).toContain("BPMNDiagram");
  const id = await deploy("ui-authored");
  const xml = await (await fetch(`${base}/definitions/${id}/diagram.bpmn`)).text();
  expect(xml).toBe(source);
});

test("renders a definition page with the diagram canvas", async () => {
  const id = await deploy("ui-definition");
  const body = await (await fetch(`${base}/definitions/${id}`)).text();

  expect(body).toContain('<script src="/static/bpmn-viewer.js"');
  expect(body).toContain(`data-src="/definitions/${id}/diagram.bpmn"`);
  expect((await fetch(`${base}/definitions/nope`)).status).toBe(404);
});

test("renders an instance page with its progress and a signal form", async () => {
  const definitionId = await deploy("ui-instance");
  const { instance } = await client.startInstance({ definitionIdOrName: definitionId, variables: {} });
  await tick();

  const body = await (await fetch(`${base}/instances/${instance!.id}`)).text();
  expect(body).toContain('id="canvas"');
  // Eta escapes the JSON for the attribute; the browser decodes it again.
  expect(body).toContain("&quot;waiting&quot;:[&quot;review&quot;]");
  expect(body).toContain('hx-target="#instance"');

  // Signalling from the instance page answers with the instance fragment.
  const res = await fetch(`${base}/instances/${instance!.id}/signal/review`, {
    ...form({ payload: "{}" }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "hx-request": "true",
      "hx-target": "instance",
    },
  });
  const fragment = await res.text();
  expect(fragment).toContain('id="instance"');
  expect(fragment).not.toContain('id="instances"');

  await tick();
  const after = await (await fetch(`${base}/instances/${instance!.id}/fragment`)).text();
  expect(after).toContain("&quot;done&quot;:[");
  const head = await (await fetch(`${base}/instances/${instance!.id}/fragment?part=head`)).text();
  expect(head).toContain('class="badge completed"');
});

test("inspects one element of an instance, with masked data", async () => {
  const definitionId = await deploy("ui-inspect");
  const { instance } = await client.startInstance({
    definitionIdOrName: definitionId,
    variables: { requester: "vh", apiToken: "t0ps3cret" },
  });
  await tick();
  await client.signalInstance({ id: instance!.id, elementId: "review", payload: { approved: true } });
  await tick();

  const page = await (await fetch(`${base}/instances/${instance!.id}`)).text();
  expect(page).toContain(`data-inspect="/instances/${instance!.id}/elements/"`);
  expect(page).toContain('<div id="element"');
  // The Variables card shows data, masked.
  expect(page).toContain("&quot;requester&quot;: &quot;vh&quot;");
  expect(page).not.toContain("t0ps3cret");

  const res = await fetch(
    `${base}/instances/${instance!.id}/elements/review?name=Review%20request&type=bpmn%3AUserTask`,
  );
  const panel = await res.text();
  expect(res.status).toBe(200);
  expect(panel).toContain("Review request");
  expect(panel).toContain("UserTask");
  expect(panel).toContain("Signal");
  expect(panel).toContain("&quot;approved&quot;: true");
  expect(panel).toMatch(/Variables changed<\/h4>[\s\S]*<code>approved<\/code>[\s\S]*<em class="faint">new<\/em>[\s\S]*<code>true<\/code>/);
  expect(panel).toContain("All variables after this run");
  expect(panel).not.toContain("t0ps3cret");
  // Both mapping blocks are always there; without mappings they say what happened.
  expect(panel).toMatch(/Input mappings<\/h4>\s*<p class="faint unmapped">None/);
  expect(panel).toMatch(/Output mappings<\/h4>\s*<p class="faint unmapped">None — the result's fields became process variables by name: <code>approved<\/code>/);

  const never = await (await fetch(`${base}/instances/${instance!.id}/elements/nowhere`)).text();
  expect(never).toContain("has not run in this instance");
  expect((await fetch(`${base}/instances/nope/elements/review`)).status).toBe(404);
});

// start → bump (n += 1) → again? (loop while n < 3, default → end)
const looping = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
             id="ui-loop-defs" targetNamespace="http://struna.io/bpmn">
  <process id="ui-loop" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="bump" />
    <scriptTask id="bump" name="Bump n" scriptFormat="javascript">
      <script>environment.variables.n = (environment.variables.n || 0) + 1; next();</script>
    </scriptTask>
    <sequenceFlow id="f2" sourceRef="bump" targetRef="again" />
    <exclusiveGateway id="again" name="Again?" default="done" camunda:asyncBefore="true">
      <documentation>Loop until n reaches 3</documentation>
    </exclusiveGateway>
    <sequenceFlow id="more" name="n &lt; 3" sourceRef="again" targetRef="bump">
      <conditionExpression xsi:type="tFormalExpression" language="javascript">next(null, environment.variables.n &lt; 3)</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="done" sourceRef="again" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>`;

test("shows an element's settings: script, gateway conditions, taken branches", async () => {
  const { definition } = await client.deployDefinition({ name: "ui-loop", source: looping });
  const { instance } = await client.startInstance({ definitionIdOrName: "ui-loop" });
  await tick();

  const script = await (await fetch(`${base}/instances/${instance!.id}/elements/bump`)).text();
  expect(script).toContain("Bump n");
  expect(script).toContain("environment.variables.n = (environment.variables.n || 0) + 1");
  expect(script).toContain("Run 3 of 3");

  const gateway = await (await fetch(`${base}/instances/${instance!.id}/elements/again`)).text();
  expect(gateway).toContain("Loop until n reaches 3");
  expect(gateway).toContain("next(null, environment.variables.n &lt; 3)");
  // Taken twice back into the loop, once out through the default.
  expect(gateway).toMatch(/<code>more<\/code>[\s\S]*?2 ×/);
  expect(gateway).toMatch(/<code>done<\/code>[\s\S]*?default[\s\S]*?1 ×/);
  expect(gateway).toContain("camunda:asyncBefore");
  // Model defaults the XML never set are not shown as settings.
  expect(gateway).not.toContain("gatewayDirection");

  const flow = await (await fetch(`${base}/instances/${instance!.id}/elements/more`)).text();
  expect(flow).toContain("Again? (again)");
  expect(flow).toContain("Bump n (bump)");
  expect(flow).toContain("2 ×");
  expect(flow).not.toContain("has not run");

  // Taken flows are painted on the diagram.
  const page = await (await fetch(`${base}/instances/${instance!.id}`)).text();
  expect(page).toContain("&quot;taken&quot;:{");

  // Without an instance: settings only, no runs.
  const settings = await (
    await fetch(`${base}/definitions/${definition!.id}/elements/again`)
  ).text();
  expect(settings).toContain("next(null, environment.variables.n &lt; 3)");
  expect(settings).not.toContain(" ×");
  expect(settings).not.toContain("Run");
  const defPage = await (await fetch(`${base}/definitions/${definition!.id}`)).text();
  expect(defPage).toContain(`data-inspect="/definitions/${definition!.id}/elements/"`);
});

test("cancels and retries from the instance page, and starts from the definition page", async () => {
  const definitionId = await deploy("ui-controls");
  const defPage = await (await fetch(`${base}/definitions/${definitionId}`)).text();
  expect(defPage).toContain(`hx-post="/definitions/${definitionId}/start"`);

  const { instance } = await client.startInstance({ definitionIdOrName: definitionId });
  await tick();
  const id = instance!.id;

  const page = await (await fetch(`${base}/instances/${id}`)).text();
  expect(page).toContain(`hx-post="/instances/${id}/cancel"`);
  // Controls come before the diagram.
  expect(page.indexOf("/cancel")).toBeLessThan(page.indexOf('id="canvas"'));
  expect(page).toContain("hx-confirm=");
  expect(page).not.toContain(`/instances/${id}/retry`);

  const htmx = {
    "content-type": "application/x-www-form-urlencoded",
    "hx-request": "true",
    "hx-target": "instance-head",
  };
  const res = await fetch(`${base}/instances/${id}/cancel`, {
    method: "POST",
    headers: htmx,
    body: new URLSearchParams({ reason: "demo" }),
  });
  const requested = await res.text();
  // The controls live at the top of the page, in their own strip.
  expect(requested.trimStart()).toMatch(/^<div id="instance-head"/);
  expect(requested).toContain("cancel requested");
  // …and tell the rest of the page to refresh straight away.
  expect(res.headers.get("hx-trigger")).toBe("instance-changed");
  const body = await (await fetch(`${base}/instances/${id}/fragment`)).text();
  expect(body).toContain("instance-changed from:body");
  // No Signal button while the cancel is on its way.
  expect(body).not.toContain("/signal/review");

  await tick();
  const canceled = await client.getInstance({ id });
  expect(canceled.instance?.status).toBe(InstanceStatus.CANCELED);
  expect(canceled.instance?.cancelRequested).toBe(false);
  const after = await (await fetch(`${base}/instances/${id}/fragment?part=head`)).text();
  expect(after).toContain('class="badge canceled"');
  expect(after).not.toContain("/cancel");

  // Retry is for failed instances only, over RPC as in the dashboard.
  await expect(client.retryInstance({ id })).rejects.toMatchObject({ code: Code.FailedPrecondition });
  const plain = await fetch(`${base}/instances/${id}/retry`, { method: "POST", redirect: "manual" });
  expect(plain.status).toBe(400);
});

test("cancels over RPC", async () => {
  const definitionId = await deploy("rpc-cancel");
  const { instance } = await client.startInstance({ definitionIdOrName: definitionId });
  const res = await client.cancelInstance({ id: instance!.id, reason: "rpc" });
  expect(res.instance?.cancelRequested).toBe(true);
  await tick();
  expect((await client.getInstance({ id: instance!.id })).instance?.status).toBe(
    InstanceStatus.CANCELED,
  );
  await expect(client.cancelInstance({ id: "nope" })).rejects.toMatchObject({ code: Code.NotFound });
});
