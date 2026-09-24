import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, expect, test } from "vitest";
import { disconnectPrisma, prisma } from "../src/db/client.js";
import { EventFeed } from "../src/engine/event-feed.js";
import { ProcessEngine } from "../src/engine/process-engine.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const source = readFileSync("examples/hello.bpmn", "utf8");
const db = prisma(TEST_DATABASE_URL);

afterAll(async () => {
  await disconnectPrisma();
});

test("an event that commits after a later one is still delivered, once", async () => {
  const engine = new ProcessEngine(db);
  const { id } = await engine.deploy("late-commit", source);
  const { id: instanceId } = await engine.start(id, {});

  const feed = new EventFeed(db, 20);
  const abort = new AbortController();
  const seen: string[] = [];
  const reading = (async () => {
    for await (const event of feed.subscribe({ instanceId, signal: abort.signal })) {
      seen.push(event.type);
    }
  })();

  // `early` takes the lower id but its transaction stays open while `later`
  // commits and is read, so the cursor moves past `early` before it exists.
  let commitEarly!: () => void;
  const early = db.$transaction(async (tx) => {
    await tx.processEvent.create({ data: { instanceId, type: "early" } });
    await new Promise<void>((resolve) => (commitEarly = resolve));
  });
  await sleep(50);
  await db.processEvent.create({ data: { instanceId, type: "later" } });

  for (let i = 0; i < 50 && !seen.includes("later"); i++) await sleep(20);
  expect(seen).toEqual(["later"]);

  commitEarly();
  await early;
  for (let i = 0; i < 50 && !seen.includes("early"); i++) await sleep(20);
  // A few more polls: the late row stays in the look-back window, and must
  // not be delivered again.
  await sleep(100);

  abort.abort();
  await reading;
  expect(seen).toEqual(["later", "early"]);
});
