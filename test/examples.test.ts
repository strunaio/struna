import { readFileSync } from "node:fs";
import { afterAll, expect, test } from "vitest";
import { disconnectPrisma, prisma } from "../src/db/client.js";
import { ProcessEngine } from "../src/engine/process-engine.js";
import { Worker } from "../src/engine/worker.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

const videoRender = readFileSync("examples/video-render.bpmn", "utf8");
const db = prisma(TEST_DATABASE_URL);
const engine = new ProcessEngine(db);

afterAll(async () => {
  await disconnectPrisma();
});

async function drain(): Promise<void> {
  const worker = new Worker(db);
  while ((await worker.tick()).more);
}

/** Signal a waiting task, let workers run, and report what it waits on next. */
async function complete(
  instanceId: string,
  elementId: string,
  payload: Record<string, unknown> = {},
): Promise<string[]> {
  expect(await engine.waitingActivities(instanceId)).toContain(elementId);
  await engine.signal(instanceId, elementId, payload);
  await drain();
  return (await engine.waitingActivities(instanceId)).sort();
}

async function startVideo(variables: Record<string, unknown>): Promise<string> {
  const { id } = await engine.deploy(`video-render-${Math.random()}`, videoRender);
  const instance = await engine.start(id, variables);
  await drain();
  expect(await engine.waitingActivities(instance.id)).toEqual(["draft_script"]);
  return instance.id;
}

test("agents draft, people approve, and the video is published", async () => {
  const id = await startVideo({ brief: "60s product teaser", budget_usd: 100 });

  expect(await complete(id, "draft_script", { script: "v1", scenes: 5 })).toEqual(["review_script"]);
  // Sent back once: the gateway reads the reviewer's answer from variables.
  expect(
    await complete(id, "review_script", { approved: false, feedback: "shorter intro" }),
  ).toEqual(["draft_script"]);
  expect(await complete(id, "draft_script", { script: "v2", scenes: 5 })).toEqual(["review_script"]);

  // 5 scenes × $12 = $60, within budget: both asset agents start at once.
  expect(await complete(id, "review_script", { approved: true })).toEqual([
    "generate_storyboard",
    "generate_voiceover",
  ]);
  expect(await complete(id, "generate_storyboard", { frames: ["a.png"] })).toEqual([
    "generate_voiceover",
  ]);
  expect(await complete(id, "generate_voiceover", { audio: "vo.mp3" })).toEqual(["render_video"]);
  expect(await complete(id, "render_video", { url: "https://cdn/video.mp4" })).toEqual([
    "final_review",
  ]);
  expect(await complete(id, "final_review", { approved: true })).toEqual([]);

  const done = await engine.getInstance(id);
  expect(done.status).toBe("completed");
  expect(done.variables).toMatchObject({
    brief: "60s product teaser",
    // Merged by name: the latest draft and the agents' results.
    script: "v2",
    scenes: 5,
    frames: ["a.png"],
    audio: "vo.mp3",
    url: "https://cdn/video.mp4",
    estimate_usd: 60,
    // Mapped: each approval under its own name, the rejection's feedback kept.
    script_approved: true,
    script_feedback: null,
    release_approved: true,
    // A FEEL zeebe:script's value, under its resultVariable.
    publication: { url: "https://cdn/video.mp4" },
  });
  expect(typeof (done.variables as { publication: { at: unknown } }).publication.at).toBe("string");
  expect(done.variables).not.toHaveProperty("approved");
  const ended = await db.processEvent.findMany({
    where: { instanceId: id, type: "activity.end", elementId: { in: ["published", "rejected"] } },
  });
  expect(ended.map((e) => e.elementId)).toEqual(["published"]);
});

test("an estimate over budget waits for a producer, who can stop it", async () => {
  const id = await startVideo({ brief: "feature film", budget_usd: 50 });

  await complete(id, "draft_script", { script: "epic", scenes: 40 });
  // 40 × $12 = $480 > $50.
  expect(await complete(id, "review_script", { approved: true })).toEqual(["approve_budget"]);
  expect(await complete(id, "approve_budget", { approved: false })).toEqual([]);

  expect((await engine.getInstance(id)).status).toBe("completed");
  const ended = await db.processEvent.findFirst({
    where: { instanceId: id, type: "activity.end", elementId: "stopped_over_budget" },
  });
  expect(ended).not.toBeNull();
});

test("a render that runs over 2 hours goes to a person", async () => {
  const id = await startVideo({ brief: "short", budget_usd: 100 });
  await complete(id, "draft_script", { scenes: 2 });
  await complete(id, "review_script", { approved: true });
  await complete(id, "generate_storyboard", {});
  expect(await complete(id, "generate_voiceover", {})).toEqual(["render_video"]);

  // Parked on the render with its 2-hour timer as the wake-up.
  const parked = await engine.getInstance(id);
  const wake = parked.runnableAt!.getTime() - Date.now();
  expect(wake).toBeGreaterThan(119 * 60_000);
  expect(wake).toBeLessThanOrEqual(120 * 60_000);

  // Two hours pass: move the saved timer and the wake-up into the past.
  const state = JSON.stringify(parked.state).replace(
    /"expireAt":"([^"]+)"/g,
    () => `"expireAt":"${new Date(Date.now() - 1000).toISOString()}"`,
  );
  await db.processInstance.update({
    where: { id },
    data: { state: JSON.parse(state) as object, runnableAt: new Date() },
  });
  await drain();

  expect((await engine.waitingActivities(id)).sort()).toEqual(["investigate_render"]);
  // Fixed: back to the render agent.
  expect(await complete(id, "investigate_render", {})).toEqual(["render_video"]);
});
