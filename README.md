# struna

BPMN-driven process server: deploy BPMN 2.0 definitions, run them, and drive
them over a Connect RPC API.

## Stack

| Concern | Choice |
| --- | --- |
| Language | TypeScript 7, ESM, `nodenext` |
| CLI | Commander 15 |
| Workflow engine | bpmn-engine 26 (+ bpmn-moddle for validation) |
| RPC | ConnectRPC 2 (`@connectrpc/connect`, `connect-node`) + protobuf-es 2 |
| Persistence | Postgres 18, Prisma 7 with the `pg` driver adapter |
| UI | htmx 2 (+ SSE extension), Eta 4 templates, bpmn-js 18 viewer |
| Tests | Vitest 5 |

## Getting started

```bash
cp .env.example .env
npm install          # `prepare` runs buf generate + prisma generate
npm run db:up        # Postgres 18 from compose.yaml, on localhost:5433
npm run db:migrate   # apply prisma/migrations to the `struna` database
npm run serve        # or: npm run dev  (watch mode); both embed a worker
```

Compose publishes Postgres on **5433** so it can sit next to a Postgres you
already run on 5432. It creates two databases: `struna` for development and
`struna_test`, which `npm test` wipes and rebuilds on every run.

To use a Postgres you already run instead, skip `db:up`, create the two
databases (`createdb struna && createdb struna_test`) and point `DATABASE_URL`
and `TEST_DATABASE_URL` in `.env` at them. The tests read `.env` too, and
refuse to reset any database whose name does not end in `_test`.

The server listens on `http://127.0.0.1:8080` by default and serves both the
RPC API and the dashboard from the same port.

```bash
npx struna serve --port 9000 --host 0.0.0.0
```

## Execution model

`struna serve` never runs BPMN itself. `StartInstance` and `SignalInstance`
only write to the database: a new instance is `pending`, a signal goes into
the instance's inbox. Workers do all execution, and they share nothing but
the database:

| How | Use it for |
| --- | --- |
| `struna serve --worker` | one process doing everything — local dev, small installs |
| `WorkerService/Tick` RPC | request-driven execution, e.g. Cloud Scheduler hitting Cloud Run |
| `struna worker` | a long-running worker; run more of them to scale out |

`struna worker` is just `Tick` in a loop, so all three behave the same. A tick
claims runnable instances one at a time — each claim is a lease on the row
(`lockedBy` / `lockedUntil`), renewed while the instance runs — then restores
the engine from its saved state, applies queued signals in order, runs until
the instance is at rest (waiting, on a timer, or finished), saves and releases
it. No worker keeps an engine between ticks, so any worker can pick up any
instance next, and a crashed worker's lease simply expires.

```bash
# Tick once; budgetMs / maxItems bound the call (defaults 10s / 100 instances)
curl -sX POST http://127.0.0.1:8080/struna.v1.WorkerService/Tick \
  -H 'Content-Type: application/json' -d '{"budgetMs":20000}'
```

Set `STRUNA_TICK_TOKEN` to require `Authorization: Bearer <token>` on Tick;
without it the RPC is open (fine behind Cloud Run IAM or on a private network).

**Timers are durable.** A timer does not fire in memory: the worker saves the
instance with `runnableAt` set to the due time, and whichever tick comes after
that resumes it. Timer precision is therefore "next tick after due".

**At-least-once.** State is saved when an instance comes to rest. If a worker
dies mid-run, the next one repeats everything since the last save — service
tasks should be idempotent. A run is also cut off after 30s (it is stopped,
saved and retried on the next tick), which bounds a task that never returns.

## Dashboard

The dashboard is an htmx app with a header menu: **Overview** (everything at a
glance), **Definitions** (each with a **Start** form, which takes you to the new
instance), **Instances** (a **Signal** button for each activity one is parked
on) and **Events** (the live engine feed over SSE). The header also shows
whether this server runs an embedded worker.

Definition and instance names link to pages that draw the process with
[bpmn-js](https://bpmn.io/toolkit/bpmn-js/) (the navigated viewer: pan and
zoom, no editing). On an instance page, elements are coloured from the event
log — finished, waiting, failed — and repainted live as the instance moves.
Definitions deployed without diagram interchange (no `<bpmndi:BPMNDiagram>`,
like `examples/hello.bpmn`) are laid out automatically with
`bpmn-auto-layout`; ones that carry their own layout are drawn as authored.

The HTML routes call `ProcessEngine` directly rather than going back through
Connect — same process, no client bundle, no second copy of the domain types.

| Route | Purpose |
| --- | --- |
| `GET /` | overview: definitions, recent instances, live feed |
| `GET /definitions` | definitions page; with `HX-Request`, just the table |
| `GET /instances` | instances page; with `HX-Request`, just the table |
| `GET /events` | events page |
| `GET /definitions/:id` | definition page with its diagram |
| `GET /definitions/:id/diagram.bpmn` | BPMN XML with a layout, for bpmn-js |
| `GET /instances/:id` | instance page: coloured diagram, status, signals, event log |
| `GET /instances/:id/fragment` | the instance page's live part (htmx swaps this) |
| `POST /definitions/:id/start` | start an instance, then redirect to it (`HX-Redirect`, or 303) |
| `POST /instances/:id/signal/:elementId` | signal a waiting activity; answers with the fragment named by `HX-Target` |
| `GET /events/stream` | SSE stream of engine events as `<li>` fragments |
| `GET /favicon.svg` | the brand mark |
| `GET /static/htmx.js`, `/static/sse.js` | served from the installed packages |
| `GET /static/bpmn-viewer.js`, `/static/diagram-js.css`, `/static/bpmn-js.css` | bpmn-js, same |

Refresh is event-driven: the instances table carries
`hx-trigger="sse:engine, every 30s"`, so anything that moves the engine —
including a change made over the RPC API — updates the page.

Colours: neutral greys, with violet only for the brand mark, the active tab
and focus rings. Blue, green, red and grey are kept for status (running,
completed, failed, pending), so nothing else competes with them.

## Trying the API

```bash
BASE=http://127.0.0.1:8080/struna.v1.ProcessService

# Deploy the sample process
SRC=$(python3 -c "import json;print(json.dumps(open('examples/hello.bpmn').read()))")
curl -sX POST $BASE/DeployDefinition -H 'Content-Type: application/json' \
  -d "{\"name\":\"hello\",\"source\":$SRC}"

# Start its latest version (it parks on the `review` user task), then signal
# that task. `definitionIdOrName` also takes a definition id to pin a version.
curl -sX POST $BASE/StartInstance -H 'Content-Type: application/json' \
  -d '{"definitionIdOrName":"hello","variables":{"requester":"vh"}}'
curl -sX POST $BASE/SignalInstance -H 'Content-Type: application/json' \
  -d '{"id":"<instance-id>","elementId":"review","payload":{"approved":true}}'
```

Nothing moves until a worker ticks: with `npm run serve` that is immediate,
otherwise call `WorkerService/Tick` or run `struna worker`.

`WatchInstance` is a server-streaming RPC that replays an instance's event log
and then follows it.

## Layout

```
proto/struna/v1/process.proto   API contract (buf lint + buf generate)
prisma/schema.prisma            definitions, instances, signals, event log
prisma/migrations/              SQL migrations (prisma migrate)
compose.yaml                    local Postgres for dev and tests
docker/postgres-init/           creates the struna_test database
prisma.config.ts                Prisma 7 CLI config (datasource url)
src/cli.ts                      Commander entry point
src/commands/serve.ts           `serve` command
src/commands/worker.ts          `worker` command
src/server/server.ts            HTTP listener: Connect routes + UI fallback
src/server/routes.ts            ProcessService implementation
src/server/worker-routes.ts     WorkerService (Tick) implementation
src/server/ui.ts                dashboard routes, SSE feed, asset serving
src/server/diagram.ts           auto-layout for BPMN without diagram interchange
src/engine/process-engine.ts    API side: definitions, queue starts/signals
src/engine/worker.ts            tick(): claim, run, save, release
src/engine/event-feed.ts        tail of the event log for streams and SSE
src/views/*.eta                 Eta templates (`_`-prefixed ones are fragments)
src/gen/                        generated code (git-ignored, run `npm run gen`)
```

## Scripts

| Script | Does |
| --- | --- |
| `npm run dev` | `serve --worker` with reload on change |
| `npm run serve` | `serve --worker` |
| `npm run worker` | a standalone worker against `DATABASE_URL` |
| `npm run build` | `tsc` (templates are read from `src/views` at runtime) |
| `npm run typecheck` | type-check src, tests and configs |
| `npm test` | Vitest against `struna_test` (rebuilt from the migrations each run; override with `TEST_DATABASE_URL`) |
| `npm run gen` | regenerate protobuf and Prisma client |
| `npm run lint:proto` | `buf lint` |
| `npm run db:up` | start the compose Postgres and wait until it is healthy |
| `npm run db:migrate` | `prisma migrate dev`: apply migrations, create one after a schema change |
| `npm run db:deploy` | `prisma migrate deploy`: apply pending migrations (production, CI) |
| `npm run db:studio` | Prisma Studio |

## Notes

- **Protocols.** The listener is HTTP/1.1, which serves the Connect and
  gRPC-Web protocols. Plain gRPC clients need HTTP/2 — swap `http.createServer`
  in `src/server/server.ts` for `http2.createServer` if you need them.
- **Database.** Postgres only. Tables and columns are snake_case (mapped in
  `prisma/schema.prisma`); variables, engine state and payloads are `jsonb`;
  timestamps are `timestamptz`. Schema changes go through
  `prisma/migrations` — run `npm run db:migrate` after editing the schema, and
  `npm run db:deploy` (or `prisma migrate deploy`) before starting a new
  release. `serve` and `worker` refuse to start on an out-of-date schema.
- **Ids.** Definitions and instances use UUIDv7 in native `uuid` columns:
  time-ordered, so they sort by creation and index well. Events and signals
  use `bigserial`: engine events routinely share a millisecond and come from
  several processes, so neither `createdAt` nor a UUIDv7 can order the log,
  the feed cursor or the signal inbox.
- **Claiming.** A worker takes an instance with one
  `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`, so concurrent
  workers pass over each other's rows instead of queueing on them.
- **Event fan-out polls the log.** Events are written by whichever process ran
  the instance, so `WatchInstance` and the SSE feed tail `process_events` by
  id (every 250ms) instead of listening in-process. A bigserial id is taken at
  insert but visible at commit, so a lower id can show up after a higher one
  was read; each poll also re-reads the last 5s and skips ids it already
  delivered, so a late row arrives (slightly out of order) rather than never.
- **Deploying `dist/`.** Templates load from `src/views`, so ship that
  directory next to `dist/`.
