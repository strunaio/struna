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
    draft_script: { script: "v2", scenes: 5 },
    review_script: { approved: true },
    estimate_cost: { usd: 60 },
    publish: { url: "https://cdn/video.mp4" },
  });
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

// --- Localization QA -------------------------------------------------------

const localizationQa = readFileSync("examples/localization-qa.bpmn", "utf8");

async function startQa(variables: Record<string, unknown>): Promise<string> {
  const { id } = await engine.deploy(`localization-qa-${Math.random()}`, localizationQa);
  const instance = await engine.start(id, { project: "acme-3.2", locale: "de-DE", ...variables });
  await drain();
  expect(await engine.waitingActivities(instance.id)).toEqual(["automated_checks"]);
  expect(await complete(instance.id, "automated_checks", { issues: [] })).toEqual(["lqa_review"]);
  return instance.id;
}

async function endedAt(instanceId: string): Promise<string[]> {
  const events = await db.processEvent.findMany({
    where: { instanceId, type: "activity.end", elementId: { in: ["delivered", "reminded"] } },
    orderBy: { id: "asc" },
  });
  return events.map((e) => e.elementId ?? "");
}

test("a clean translation passes review on its own and is delivered", async () => {
  const id = await startQa({ sample_rate: 0 });

  expect(await complete(id, "lqa_review", { score: 99, critical: 0, errors: [] })).toEqual([
    "visual_qa",
  ]);
  expect(await complete(id, "visual_qa", { issues: [] })).toEqual(["client_review"]);
  expect(await complete(id, "client_review", { approved: true })).toEqual(["update_tm"]);
  expect(await complete(id, "update_tm", { segments: 120 })).toEqual([]);

  const done = await engine.getInstance(id);
  expect(done.status).toBe("completed");
  expect(done.variables).toMatchObject({ triage: { route: "pass", sampled: false } });
  expect(await endedAt(id)).toEqual(["delivered"]);
});

test("auto-fix gets two rounds, then a linguist takes over", async () => {
  const id = await startQa({ sample_rate: 0 });

  // 95 is between fix_score (90) and pass_score (98): the agent fixes it.
  expect(await complete(id, "lqa_review", { score: 95, critical: 0 })).toEqual(["auto_fix"]);
  expect(await complete(id, "auto_fix", { fixed: 3 })).toEqual(["lqa_review"]);
  expect(await complete(id, "lqa_review", { score: 96, critical: 0 })).toEqual(["auto_fix"]);
  expect(await complete(id, "auto_fix", { fixed: 1 })).toEqual(["lqa_review"]);
  // Still not good enough, and out of rounds.
  expect(await complete(id, "lqa_review", { score: 97, critical: 0 })).toEqual(["linguist_review"]);
  expect((await engine.getInstance(id)).variables).toMatchObject({
    fix_rounds: 2,
    triage: { route: "linguist", rounds: 2 },
  });

  expect(await complete(id, "linguist_review", { edited: 8 })).toEqual(["visual_qa"]);
  // A truncated button goes back to an agent, then to visual QA again.
  expect(
    await complete(id, "visual_qa", { issues: [{ screen: "checkout", problem: "truncated" }] }),
  ).toEqual(["fix_ui"]);
  expect(await complete(id, "fix_ui", { changed: ["checkout.pay"] })).toEqual(["visual_qa"]);
  expect(await complete(id, "visual_qa", { issues: [] })).toEqual(["client_review"]);
});

test("critical errors, failed spot checks and client feedback all reach a linguist", async () => {
  const critical = await startQa({ sample_rate: 0 });
  expect(await complete(critical, "lqa_review", { score: 99, critical: 1 })).toEqual([
    "linguist_review",
  ]);

  // Every pass is sampled here; the linguist disagrees with the agent.
  const sampled = await startQa({ sample_rate: 1 });
  expect(await complete(sampled, "lqa_review", { score: 99, critical: 0 })).toEqual(["spot_check"]);
  expect(await complete(sampled, "spot_check", { ok: false, note: "tone" })).toEqual([
    "linguist_review",
  ]);
  expect(await complete(sampled, "linguist_review", {})).toEqual(["visual_qa"]);
  expect(await complete(sampled, "visual_qa", { issues: [] })).toEqual(["client_review"]);
  expect(
    await complete(sampled, "client_review", { approved: false, feedback: "use formal Sie" }),
  ).toEqual(["linguist_review"]);
});

test("a client who has not answered in 2 days is reminded; the review stays open", async () => {
  const id = await startQa({ sample_rate: 0 });
  await complete(id, "lqa_review", { score: 99, critical: 0 });
  expect(await complete(id, "visual_qa", { issues: [] })).toEqual(["client_review"]);

  const parked = await engine.getInstance(id);
  const wake = parked.runnableAt!.getTime() - Date.now();
  expect(wake).toBeGreaterThan(47 * 60 * 60_000);
  expect(wake).toBeLessThanOrEqual(48 * 60 * 60_000);

  // Two days pass.
  const state = JSON.stringify(parked.state).replace(
    /"expireAt":"([^"]+)"/g,
    () => `"expireAt":"${new Date(Date.now() - 1000).toISOString()}"`,
  );
  await db.processInstance.update({
    where: { id },
    data: { state: JSON.parse(state) as object, runnableAt: new Date() },
  });
  await drain();

  // Non-interrupting: the reminder runs alongside the open review.
  expect((await engine.waitingActivities(id)).sort()).toEqual(["client_review", "remind_client"]);
  expect(await complete(id, "remind_client", { sent: "email" })).toEqual(["client_review"]);
  expect(await complete(id, "client_review", { approved: true })).toEqual(["update_tm"]);
  await complete(id, "update_tm", {});

  expect((await engine.getInstance(id)).status).toBe("completed");
  expect(await endedAt(id)).toEqual(["reminded", "delivered"]);
});
