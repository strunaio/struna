import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProcessEngine } from "../engine/process-engine.js";
import { ProcessError } from "../engine/process-engine.js";
import { diagramXml } from "./diagram.js";
import { describeElement } from "./element-definition.js";
import { render } from "./views.js";

const DASHBOARD_LIMIT = 25;
const LIST_LIMIT = 100;
const FEED_LIMIT = 30;
const EVENTS_PAGE_LIMIT = 100;

/** The header's brand mark on a violet tile, as the tab icon. */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#6d28d9"/><g transform="translate(4 4)" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="2.5" cy="12" r=".6" fill="#fff"/><path d="M4.5 12c1.8 0 2-5 3.9-5s2 10 3.6 10 1.8-10 3.6-10 2.1 5 3.9 5"/><circle cx="21.5" cy="12" r=".6" fill="#fff"/></g></svg>`;

const JS = "text/javascript; charset=utf-8";
const CSS = "text/css; charset=utf-8";

/** Client libraries are served straight from the installed packages. */
const ASSETS: Record<string, { specifier: string; type: string }> = {
  "/static/htmx.js": { specifier: "htmx.org/dist/htmx.min.js", type: JS },
  "/static/sse.js": { specifier: "htmx-ext-sse/dist/sse.js", type: JS },
  "/static/bpmn-viewer.js": {
    specifier: "bpmn-js/dist/bpmn-navigated-viewer.production.min.js",
    type: JS,
  },
  "/static/diagram-js.css": { specifier: "bpmn-js/dist/assets/diagram-js.css", type: CSS },
  "/static/bpmn-js.css": { specifier: "bpmn-js/dist/assets/bpmn-js.css", type: CSS },
};

const assetCache = new Map<string, string>();

function asset(specifier: string): string {
  let body = assetCache.get(specifier);
  if (body === undefined) {
    body = readFileSync(fileURLToPath(import.meta.resolve(specifier)), "utf8");
    assetCache.set(specifier, body);
  }
  return body;
}

interface Route {
  readonly method: "GET" | "POST";
  readonly pattern: RegExp;
  readonly handle: (
    ctx: UiContext,
    params: Record<string, string>,
  ) => Promise<void> | void;
}

interface UiContext {
  readonly engine: ProcessEngine;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** Whether this server runs an embedded worker; shown in the header. */
  readonly worker: boolean;
}

type NavTab = "overview" | "definitions" | "instances" | "events";

/** Render a full page, giving the layout what its header needs. */
function page(
  ctx: UiContext,
  template: string,
  active: NavTab,
  data: Record<string, unknown>,
): void {
  html(ctx.res, render(template, { ...data, nav: { active, worker: ctx.worker } }));
}

/**
 * htmx's own requests (polling, swaps) want just the fragment; a browser
 * navigating to the same URL wants the whole page.
 */
function wantsFragment(req: IncomingMessage): boolean {
  return req.headers["hx-request"] === "true" && req.headers["hx-boosted"] !== "true";
}

function html(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

/** Read an `application/x-www-form-urlencoded` body. */
async function formBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // A dashboard form is tiny; refuse anything that clearly is not one.
    if (size > 64 * 1024) throw new Error("form body too large");
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function parseJsonField(raw: string | null, field: string): Record<string, unknown> {
  const text = (raw ?? "").trim();
  if (text === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProcessError(`${field} must be valid JSON`, "invalid_argument");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProcessError(`${field} must be a JSON object`, "invalid_argument");
  }
  return parsed as Record<string, unknown>;
}

async function definitionsModel(engine: ProcessEngine, take: number) {
  return { definitions: await engine.listDefinitions(take, 0) };
}

/** Instances with the elements each running one is parked on. */
async function instancesModel(engine: ProcessEngine, take: number) {
  const instances = await engine.listInstances(take);
  const rows = await Promise.all(
    instances.map(async (instance) => ({
      ...instance,
      waiting:
        instance.status === "running"
          ? await engine.waitingActivities(instance.id)
          : [],
    })),
  );
  return { instances: rows };
}

/** Everything the instance page's live fragment needs. */
async function instanceModel(engine: ProcessEngine, id: string) {
  const instance = await engine.getInstance(id);
  const [definition, progress, events] = await Promise.all([
    engine.getDefinition(instance.definitionId),
    engine.elementProgress(id),
    engine.instanceEvents(id),
  ]);
  // Shown masked; GetInstance returns the stored values.
  return { instance, definition, progress, events, variables: engine.redact(instance.variables) };
}

async function renderInstance(engine: ProcessEngine, id: string): Promise<string> {
  return render("./_instance.eta", await instanceModel(engine, id));
}

const ROUTES: Route[] = [
  {
    method: "GET",
    pattern: /^\/$/,
    async handle(ctx) {
      const { engine } = ctx;
      const [definitions, instances, events] = await Promise.all([
        definitionsModel(engine, DASHBOARD_LIMIT),
        instancesModel(engine, DASHBOARD_LIMIT),
        engine.recentEvents(FEED_LIMIT),
      ]);
      page(ctx, "./dashboard.eta", "overview", {
        ...definitions,
        ...instances,
        events,
        title: "struna",
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/definitions$/,
    async handle(ctx) {
      const model = await definitionsModel(ctx.engine, LIST_LIMIT);
      if (wantsFragment(ctx.req)) return html(ctx.res, render("./_definitions.eta", model));
      page(ctx, "./definitions.eta", "definitions", { ...model, title: "Definitions · struna" });
    },
  },
  {
    method: "GET",
    pattern: /^\/instances$/,
    async handle(ctx) {
      const model = await instancesModel(ctx.engine, LIST_LIMIT);
      if (wantsFragment(ctx.req)) return html(ctx.res, render("./_instances.eta", model));
      page(ctx, "./instances.eta", "instances", { ...model, title: "Instances · struna" });
    },
  },
  {
    method: "GET",
    pattern: /^\/events$/,
    async handle(ctx) {
      const events = await ctx.engine.recentEvents(EVENTS_PAGE_LIMIT);
      page(ctx, "./events.eta", "events", { events, title: "Events · struna" });
    },
  },
  {
    method: "GET",
    pattern: /^\/favicon\.svg$/,
    handle({ res }) {
      res.writeHead(200, {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=86400",
      });
      res.end(FAVICON);
    },
  },
  {
    method: "GET",
    pattern: /^\/definitions\/(?<id>[^/]+)$/,
    async handle(ctx, params) {
      const definition = await ctx.engine.getDefinition(params["id"] as string);
      page(ctx, "./definition.eta", "definitions", {
        definition,
        title: `${definition.name} v${definition.version} · struna`,
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/definitions\/(?<id>[^/]+)\/diagram\.bpmn$/,
    async handle({ engine, res }, params) {
      const definition = await engine.getDefinition(params["id"] as string);
      res.writeHead(200, {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(await diagramXml(definition.id, definition.source));
    },
  },
  {
    method: "GET",
    pattern: /^\/instances\/(?<id>[^/]+)$/,
    async handle(ctx, params) {
      const model = await instanceModel(ctx.engine, params["id"] as string);
      page(ctx, "./instance.eta", "instances", {
        ...model,
        title: `${model.definition.name} · ${model.instance.id} · struna`,
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/instances\/(?<id>[^/]+)\/elements\/(?<elementId>[^/]+)$/,
    async handle({ engine, res }, params) {
      const elementId = params["elementId"] as string;
      const instance = await engine.getInstance(params["id"] as string);
      const definition = await engine.getDefinition(instance.definitionId);
      const [element, runs, progress] = await Promise.all([
        describeElement(definition.id, definition.source, elementId),
        engine.elementRuns(instance.id, elementId),
        engine.elementProgress(instance.id),
      ]);
      html(res, render("./_element.eta", { elementId, element, runs, taken: progress.taken }));
    },
  },
  {
    method: "GET",
    pattern: /^\/definitions\/(?<id>[^/]+)\/elements\/(?<elementId>[^/]+)$/,
    async handle({ engine, res }, params) {
      const elementId = params["elementId"] as string;
      const definition = await engine.getDefinition(params["id"] as string);
      const element = await describeElement(definition.id, definition.source, elementId);
      // No instance: the definition half only.
      html(res, render("./_element.eta", { elementId, element, runs: null, taken: null }));
    },
  },
  {
    method: "GET",
    pattern: /^\/instances\/(?<id>[^/]+)\/fragment$/,
    async handle({ engine, res }, params) {
      html(res, await renderInstance(engine, params["id"] as string));
    },
  },
  {
    method: "POST",
    pattern: /^\/definitions\/(?<id>[^/]+)\/start$/,
    async handle({ engine, req, res }, params) {
      const form = await formBody(req);
      const instance = await engine.start(
        params["id"] as string,
        parseJsonField(form.get("variables"), "variables"),
      );
      // Go to the new instance: htmx follows HX-Redirect, a plain form post
      // follows the 303.
      const location = `/instances/${encodeURIComponent(instance.id)}`;
      if (wantsFragment(req)) {
        res.writeHead(200, { "hx-redirect": location });
      } else {
        res.writeHead(303, { location });
      }
      res.end();
    },
  },
  {
    method: "POST",
    pattern: /^\/instances\/(?<id>[^/]+)\/signal\/(?<elementId>[^/]+)$/,
    async handle({ engine, req, res }, params) {
      const form = await formBody(req);
      const id = params["id"] as string;
      await engine.signal(
        id,
        params["elementId"] as string,
        parseJsonField(form.get("payload"), "payload"),
      );
      // The same form lives in the instances table and on the instance page;
      // htmx names the element it will swap, so answer with that fragment.
      html(
        res,
        req.headers["hx-target"] === "instance"
          ? await renderInstance(engine, id)
          : render("./_instances.eta", await instancesModel(engine, LIST_LIMIT)),
      );
    },
  },
  {
    method: "GET",
    pattern: /^\/events\/stream$/,
    async handle({ engine, req, res }) {
      // Take the cursor before announcing the stream, so nothing the client
      // triggers after connecting can land before it.
      const after = await engine.events.latestSeq();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Defeat proxy buffering so the first event is not held back.
      res.write(": connected\n\n");

      const abort = new AbortController();
      req.on("close", () => abort.abort());

      try {
        for await (const event of engine.events.subscribe({
          after,
          signal: abort.signal,
        })) {
          const fragment = render("./_event.eta", { event });
          // SSE frames are newline-delimited, so the HTML must not contain raw
          // newlines of its own.
          res.write(`event: engine\ndata: ${fragment.replace(/\n/g, " ")}\n\n`);
        }
      } finally {
        res.end();
      }
    },
  },
  {
    method: "GET",
    pattern: /^\/healthz$/,
    handle({ res }) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    },
  },
];

/**
 * Handle a non-RPC request. Returns false when nothing matched, so the caller
 * can fall through to a 404.
 */
export async function handleUi(ctx: UiContext): Promise<boolean> {
  const { req, res } = ctx;
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = req.method === "POST" ? "POST" : "GET";

  const staticAsset = ASSETS[path];
  if (staticAsset !== undefined && method === "GET") {
    res.writeHead(200, {
      "content-type": staticAsset.type,
      "cache-control": "public, max-age=3600",
    });
    res.end(asset(staticAsset.specifier));
    return true;
  }

  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (match === null) continue;

    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(match.groups ?? {})) {
      if (value !== undefined) params[key] = decodeURIComponent(value);
    }

    try {
      await route.handle(ctx, params);
    } catch (cause) {
      if (res.headersSent) {
        res.end();
      } else if (cause instanceof ProcessError) {
        const status = cause.code === "not_found" ? 404 : 400;
        html(res, render("./_error.eta", { message: cause.message }), status);
      } else {
        html(
          res,
          render("./_error.eta", { message: "internal error" }),
          500,
        );
      }
    }
    return true;
  }
  return false;
}
