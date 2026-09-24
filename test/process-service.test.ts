import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createClient, type Client, ConnectError, Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { InstanceStatus, ProcessService } from "../src/gen/struna/v1/process_pb.js";
import { WorkerService } from "../src/gen/struna/v1/worker_pb.js";
import { startServer, type RunningServer } from "../src/server/server.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const source = readFileSync("examples/hello.bpmn", "utf8");

let server: RunningServer;
let client: Client<typeof ProcessService>;
let workers: Client<typeof WorkerService>;

/** The server only queues work; drain it the way a scheduler would. */
async function tick(): Promise<void> {
  while ((await workers.tick({})).more);
}

beforeAll(async () => {
  // Port 0 lets the OS pick a free port.
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databaseUrl: TEST_DATABASE_URL,
    worker: false,
  });
  const transport = createConnectTransport({ baseUrl: server.url, httpVersion: "1.1" });
  client = createClient(ProcessService, transport);
  workers = createClient(WorkerService, transport);
});

afterAll(async () => {
  await server?.close();
});

test("deploys a definition and bumps the version on redeploy", async () => {
  const first = await client.deployDefinition({ name: "versioned", source });
  const second = await client.deployDefinition({ name: "versioned", source });

  expect(first.definition?.version).toBe(1);
  expect(second.definition?.version).toBe(2);
});

test("starts the latest version when given a definition name", async () => {
  await client.deployDefinition({ name: "by-name", source });
  const { definition: latest } = await client.deployDefinition({ name: "by-name", source });

  const { instance } = await client.startInstance({ definitionIdOrName: "by-name" });
  expect(instance?.definitionId).toBe(latest!.id);
});

test("starts an older version when given its id", async () => {
  const { definition: first } = await client.deployDefinition({ name: "pinned", source });
  await client.deployDefinition({ name: "pinned", source });

  const { instance } = await client.startInstance({ definitionIdOrName: first!.id });
  expect(instance?.definitionId).toBe(first!.id);
});

test("refuses a definition name that looks like an id", async () => {
  const failure = client.deployDefinition({
    name: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    source,
  });
  await expect(failure).rejects.toMatchObject({ code: Code.InvalidArgument });
});

test("rejects a start with no definition, or an unknown id or name", async () => {
  await expect(client.startInstance({})).rejects.toMatchObject({
    code: Code.InvalidArgument,
  });
  await expect(client.startInstance({ definitionIdOrName: "nope" })).rejects.toMatchObject({
    code: Code.NotFound,
  });
  await expect(
    client.startInstance({ definitionIdOrName: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" }),
  ).rejects.toMatchObject({ code: Code.NotFound });
});

test("rejects source that is not BPMN", async () => {
  const failure = client.deployDefinition({ name: "broken", source: "<not-xml" });
  await expect(failure).rejects.toThrow(ConnectError);
  await expect(failure).rejects.toMatchObject({ code: Code.InvalidArgument });
});

test("runs an instance to completion once the user task is signaled", async () => {
  const { definition } = await client.deployDefinition({ name: "lifecycle", source });
  const { instance } = await client.startInstance({
    definitionIdOrName: definition!.id,
    variables: { requester: "vh" },
  });

  // Starting only queues the instance.
  expect(instance?.status).toBe(InstanceStatus.PENDING);
  expect(instance?.variables).toEqual({ requester: "vh" });

  await tick();
  const parked = await client.getInstance({ id: instance!.id });
  expect(parked.instance?.status).toBe(InstanceStatus.RUNNING);

  const signaled = await client.signalInstance({
    id: instance!.id,
    elementId: "review",
    payload: { approved: true },
  });
  expect(signaled.instance?.status).toBe(InstanceStatus.RUNNING);

  await tick();
  const fetched = await client.getInstance({ id: instance!.id });
  expect(fetched.instance?.status).toBe(InstanceStatus.COMPLETED);
  expect(fetched.instance?.completedAt).toBeDefined();
});

test("accepts a signal before any worker has run the instance", async () => {
  const { definition } = await client.deployDefinition({ name: "early-signal", source });
  const { instance } = await client.startInstance({
    definitionIdOrName: definition!.id,
    variables: {},
  });
  await client.signalInstance({ id: instance!.id, elementId: "review", payload: {} });

  await tick();
  const fetched = await client.getInstance({ id: instance!.id });
  expect(fetched.instance?.status).toBe(InstanceStatus.COMPLETED);
});

test("refuses to signal a finished instance", async () => {
  const { definition } = await client.deployDefinition({ name: "finished", source });
  const { instance } = await client.startInstance({
    definitionIdOrName: definition!.id,
    variables: {},
  });
  await client.signalInstance({ id: instance!.id, elementId: "review", payload: {} });
  await tick();

  const failure = client.signalInstance({ id: instance!.id, elementId: "review", payload: {} });
  await expect(failure).rejects.toMatchObject({ code: Code.FailedPrecondition });
});

test("streams engine events to WatchInstance subscribers", async () => {
  const { definition } = await client.deployDefinition({ name: "watched", source });
  const { instance } = await client.startInstance({
    definitionIdOrName: definition!.id,
    variables: {},
  });

  const abort = new AbortController();
  const seen: string[] = [];
  const collecting = (async () => {
    for await (const res of client.watchInstance(
      { id: instance!.id },
      { signal: abort.signal },
    )) {
      if (res.event !== undefined) seen.push(res.event.type);
      if (res.event?.type === "process.end") break;
    }
  })();

  await tick();
  await client.signalInstance({
    id: instance!.id,
    elementId: "review",
    payload: {},
  });
  await tick();
  await collecting;
  abort.abort();

  // The whole log, in order, with the user task's wait recorded once.
  expect(seen[0]).toBe("process.start");
  expect(seen.filter((type) => type === "activity.wait")).toHaveLength(1);
  expect(seen).toContain("process.end");
});

test("reports a missing instance as NotFound", async () => {
  const failure = client.getInstance({ id: "does-not-exist" });
  await expect(failure).rejects.toMatchObject({ code: Code.NotFound });
});
