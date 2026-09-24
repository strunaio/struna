import { afterAll, beforeAll, expect, test } from "vitest";
import { Code, createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { WorkerService } from "../src/gen/struna/v1/worker_pb.js";
import { startServer, type RunningServer } from "../src/server/server.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

let server: RunningServer;
let workers: Client<typeof WorkerService>;

beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databaseUrl: TEST_DATABASE_URL,
    worker: false,
    tickToken: "s3cret",
  });
  workers = createClient(
    WorkerService,
    createConnectTransport({ baseUrl: server.url, httpVersion: "1.1" }),
  );
});

afterAll(async () => {
  await server?.close();
});

test("rejects a Tick without the token", async () => {
  await expect(workers.tick({})).rejects.toMatchObject({ code: Code.Unauthenticated });
  await expect(
    workers.tick({}, { headers: { authorization: "Bearer wrong" } }),
  ).rejects.toMatchObject({ code: Code.Unauthenticated });
});

test("accepts a Tick with the token", async () => {
  const res = await workers.tick({}, { headers: { authorization: "Bearer s3cret" } });
  expect(res.more).toBe(false);
});
