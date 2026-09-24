import { readFileSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { disconnectPrisma, prisma, type PrismaClient } from "../src/db/client.js";
import { ProcessEngine } from "../src/engine/process-engine.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const source = readFileSync("examples/hello.bpmn", "utf8");
const db = prisma(TEST_DATABASE_URL);

afterAll(async () => {
  await disconnectPrisma();
});

/**
 * A client whose first "latest version" lookup is stale, as if another deploy
 * of the same name committed between this deploy's read and its insert.
 */
function withStaleFirstRead(client: PrismaClient): PrismaClient {
  let stale = true;
  const definitions = new Proxy(client.processDefinition, {
    get(target, prop, receiver) {
      if (prop === "findFirst" && stale) {
        stale = false;
        return async () => ({ version: 0 });
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "processDefinition") return definitions;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

test("a deploy that loses the version race retries with the next version", async () => {
  const engine = new ProcessEngine(db);
  await engine.deploy("raced", source);

  // Reads version 0, collides with the existing v1, re-reads and takes v2.
  const racing = new ProcessEngine(withStaleFirstRead(db));
  const second = await racing.deploy("raced", source);

  expect(second.version).toBe(2);
});
