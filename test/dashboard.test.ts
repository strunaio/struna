import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ProcessService } from "../src/gen/struna/v1/process_pb.js";
import { WorkerService } from "../src/gen/struna/v1/worker_pb.js";
import { startServer, type RunningServer } from "../src/server/server.js";
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
  expect(body).toContain('sse-connect="/events/stream"');
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
  for (const path of ["/static/htmx.js", "/static/sse.js"]) {
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
  const id = await deploy("ui-layout");
  expect(source).not.toContain("BPMNDiagram");

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
  expect(after).toContain('class="badge completed"');
  expect(after).toContain("&quot;done&quot;:[");
});
