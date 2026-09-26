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
| UI | htmx 2 (+ a small SSE script), Eta 4 templates, bpmn-js 18 viewer |
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
that resumes it. Timer precision is therefore "next tick after due". This
applies to BPMN timer events only; a script's own `setTimeout(next, …)` is an
ordinary timer that the worker waits out within the run (up to the 30s run
limit).

**Task results become variables the Camunda 8 way.** A task's result — the
payload it was signalled with, a service's response, what a script passed to
`next(null, …)` — reaches the process variables before the next gateway runs:

| The task has | What is written |
| --- | --- |
| nothing — user task, receive task | the result's fields, merged by name (`{sum: 42}` → `sum`), as Camunda 8 does for completions and messages |
| nothing — service task | nothing: like a Camunda connector, a service task keeps its response only where told to (it is still logged, and shown in the inspector as the step's result) |
| `zeebe:output`s | only what they map: `<zeebe:output source="=quotient" target="half" />`; the source sees the result's fields, the task's inputs and the process variables, and a missing name maps to `null` |
| task header `resultVariable` | the whole result under that name, as Camunda's connectors do |
| task header `resultExpression` | FEEL over `response`, e.g. `={total: response.sum}`; its entries become variables |

With both, Zeebe's propagation rule applies: once a task has `zeebe:output`s,
only their targets leave the step. A result variable or a result
expression's entries then stay inside it — an output can still read them
(`<zeebe:output source="=loud" target="shout" />`), and the inspector notes
under **Output mappings** that they stayed in the step.

Where this comes from: Zeebe itself treats `zeebe:taskHeaders` as opaque
metadata for the job worker. `resultVariable` and `resultExpression` are the
Camunda Connectors convention — the connector runtime reads them and
completes the job with what they produce — and struna plays that runtime for
service tasks, binding them in its templates as Camunda's connector templates
do. (Zeebe's own `resultVariable` is an attribute, on `zeebe:script` and
`zeebe:calledDecision`; struna supports the script one.) One difference: a
connector completes with only the result variable and result expression, so
its output mappings cannot read the raw response. struna's output mappings
can (`=sum`, `=quotient`), as a job worker completing with the whole response
would allow — which is what the templates' per-field outputs rely on. On
Camunda 8 itself, the result headers work only where a connector-style worker
handles the job type.

When several steps answer with the same field — every approval says
`approved` — map each to its own name, as `examples/video-render.bpmn` does.
FEEL in outputs and result expressions is checked at deploy. Element
templates offer, in their **Output mapping** group, one field per response field
(`Map quotient to` — type the variable to write; it becomes
`<zeebe:output source="=quotient" target="…" />`) plus **Result variable**
and **Result expression**. In the properties panel a FEEL value shows with a
grey `=` badge in front (`= sum`); the `=` is the FEEL marker, not text.
Variables are one set per instance: sub-process scopes are not modelled yet.

**FEEL everywhere, as in Camunda 8.** Gateway conditions written
`=total >= 100` and script tasks with
`<zeebe:script expression="=…" resultVariable="total" />` are evaluated as
FEEL over the instance's variables (a `zeebe:script` must name its
`resultVariable`). JavaScript conditions and scripts (`language="javascript"`,
`scriptFormat="javascript"`) still run, but Camunda editors flag them.

**Messages.** A receive task may wait for a Camunda 8 message
(`messageRef` plus `zeebe:subscription`). struna still delivers it by the
task's element id — `SignalInstance(elementId="wait_order", payload=…)` — and
the payload follows the task's output rules like any other result. Correlation
keys are accepted for compatibility but not used: struna delivers to an
instance by id.

An activity cut short without ending — by an interrupting boundary event,
say — is logged as `activity.discard`.

**Cancel and retry.** `CancelInstance` (or **Cancel instance** on the
instance page, which asks first and takes an optional reason) stops a pending
or running instance for good. It is a request, like a signal: the worker that
next holds the instance carries it out — so it never races a run in progress —
and records a `process.cancel` event with the reason; until then the instance
reports `cancel_requested`. `RetryInstance` (**Retry** on a failed instance)
resumes it from the last state a worker saved: where it last waited, or the
last successful service call, whichever came later. The steps since then run
again, and the signals the failed run consumed since that save are applied
again, since a failed run keeps them in its inbox. A `process.retry` event
marks the seam in the log. Neither is behind a login yet.

**At-least-once.** State is saved when an instance comes to rest and, while
it runs, after every successful service call (keeping the lease). So a
failure or a dead worker repeats only the steps since the last save — a
finished call is not made again, but the call in flight when things went
wrong may have reached the service, which is why service tasks should still
be idempotent (`struna-instance-id` and `struna-element-id` headers help). A
run is also cut off after 30s (it is stopped, saved and retried on the next
tick), which bounds a task that never returns.

## Service tasks

A service task calls a method of a Connect or gRPC service. struna needs no
code for it: it learns the service from its protobuf descriptor set and calls
the method dynamically.

**1. Register services.** A registration is a descriptor set plus where its
services run — every service in the set, or the ones you name:

```bash
buf build -o acme.binpb                     # imports included (the default)
npx struna services add --descriptor acme.binpb --url https://acme-api.run.app
npx struna services add --descriptor acme.binpb --url https://slack.run.app \
  --service acme.slack.v1.ChatService --protocol grpc   # connect (default), grpc, grpcweb
npx struna services list
npx struna services remove acme.slack.v1.ChatService
```

A service is identified by its full proto name (the package makes it unique).
Registering it again points it at the new descriptor set, URL or protocol, so
moving a service never needs a redeploy. The same registry is available as
the `struna.v1.RegistryService` RPC, which is off unless `STRUNA_ADMIN_TOKEN`
is set and then requires `Authorization: Bearer <token>` — it decides which
URLs struna calls.

**2. Call a method from a service task.** struna reads BPMN the Camunda 8
(Zeebe) way: the task definition type names the method, and `zeebe:input`s
make the request:

```xml
<definitions … xmlns:zeebe="http://camunda.org/schema/zeebe/1.0">
  …
  <serviceTask id="notify" name="Tell the client">
    <extensionElements>
      <zeebe:taskDefinition type="acme.slack.v1.ChatService/PostMessage" />
      <zeebe:ioMapping>
        <zeebe:input source="#loc-de" target="channel" />
        <zeebe:input source="=locale + &quot; is delivered&quot;" target="text" />
        <zeebe:input source="=client.email" target="recipient.email" />
      </zeebe:ioMapping>
    </extensionElements>
  </serviceTask>
```

- A source starting with `=` is FEEL (Camunda 8's expression language,
  evaluated with [feelin](https://github.com/nikku/feelin)) over the
  instance's variables: `=a + b`, `=add.sum`, `={sum: b}`. Anything else is a
  literal.
- A dotted target sets a nested field. Non-string fields take a FEEL value or
  literal JSON: `42`, `true`, `["a","b"]`, `{"k":1}`. Proto and JSON field
  names both work.
- The response, as proto JSON, is the task's result, applied by the rules
  above — as with a Camunda connector, only what an output mapping, a
  `resultVariable` or a `resultExpression` keeps reaches the variables.
- Each call carries `struna-instance-id` and `struna-element-id` headers and a
  25s timeout. A failed call fails the instance with the method and the
  service's error code and message; a FEEL expression over a missing variable
  fails it naming the expression. **Retry** calls it again.
- Deploying checks every service task: a method must be named, registered and
  unary, every input must be a field of its request, and FEEL must parse.
  Register services before deploying the processes that call them.

The inspector shows what a service task calls (linked to the service's page),
its inputs, and each call's response. The **Services** tab lists the registry;
a service's page shows its methods with the input targets and types a service
task fills in, which definitions call them, and recent calls. It is read-only
— the registry decides which URLs struna calls, so changes go through the CLI
until the dashboard has a login. Only unary methods can be called.

**3. Pick methods in your editor.** `struna templates export` writes Camunda 8
element templates for every registered service to `.camunda/element-templates/`
(one file per service, one template per method, grouped by service), which
Camunda Modeler and the BPMN Modeler extension for VS Code read. In a
Camunda 8 diagram, select a task, choose e.g. **Math › Add** as its template,
and fill in the request fields — each takes a literal or, with a leading `=`,
FEEL; blank fields write no input and keep their default. The template sets
the task definition type to the method and puts the service's icon on the
task. Re-run it after registering or changing services.

Editors draw the icon only on tasks linked to a template (the
`zeebe:modelerTemplate*` attributes picking one writes). For service tasks
written by hand, link them without opening an editor:

```bash
npx struna templates apply examples/math-demo.bpmn   # in place; safe to repeat
```

`.camunda/` is only for editors — struna itself never reads it. Commit it so
everyone gets the same templates, and re-export when services change.

Icons belong to services, not methods. Set one with `--icon` on
`services add`, or later:

```bash
npx struna services appearance acme.demo.v1.MathService --title "Calculator" --icon calc.svg
npx struna services appearance acme.demo.v1.MathService --default-icon   # back to the monogram
```

Without one, a service gets a monogram tile (its initial, on a colour derived
from its name). Editors show the icon on tasks made from a template
(`zeebe:modelerTemplateIcon`); the dashboard draws it on every service task —
the template's if the XML has one, otherwise the registered service's.

**Try it** with the demo API in `examples/services/` (a `MathService` and a
`GreeterService`, served without generated code) and `examples/math-demo.bpmn`:

```bash
npm run demo:services       # serves on :9000 and writes examples/services/demo.binpb
npx struna services add --descriptor examples/services/demo.binpb --url http://localhost:9000
# then deploy examples/math-demo.bpmn and start it with
#   {"a": 30, "b": 12, "name": "world", "locale": "uk"}
```

## Dashboard

The dashboard is an htmx app with a header menu: **Overview** (everything at a
glance), **Definitions** (each with a **Start** form, which takes you to the new
instance), **Instances** (a **Signal** button for each activity one is parked
on), **Services** (the registry, read-only) and **Events** (the live engine
feed over SSE). The header also shows
whether this server runs an embedded worker.

Definition and instance names link to pages that draw the process with
[bpmn-js](https://bpmn.io/toolkit/bpmn-js/) (the navigated viewer: pan and
zoom, no editing). On an instance page, elements are coloured from the event
log — finished, waiting, failed — and repainted live as the instance moves.
**Inspecting.** Click any element or flow on a diagram to open its inspector.
The top half is what the BPMN says: documentation, a script task's script,
a gateway's outgoing flows with their conditions (and which is the default),
a flow's condition, timer/message/signal definitions, loop settings and
extension attributes such as `zeebe:*`. On an instance page, the inspector
adds what happened, as Operate shows it: each time the element ran (a loop
shows ×N on the shape), when it started, waited and ended, the signal
payloads it received, its **input mappings** and **output mappings** with the
values they evaluated to, its raw result, the **variables it changed**
(before → after, which Operate cannot show; the full set is one click away),
and how often each branch was taken — taken flows are drawn
green. The instance page also shows
the current variables. This comes from the event log: workers record an
element's output on `activity.end`, applied signals as `signal` events, taken
flows as `flow.take`, and a `variables` snapshot whenever the data changes.

Values under sensitive keys are masked as `[redacted]` — in the log when they
are written, and on every dashboard page. `STRUNA_REDACT_KEYS` is a
comma-separated list of key fragments, matched case-insensitively and ignoring
`_`/`-` (so `token` also masks `accessToken` and `refresh_token`); the default
is `password,passwd,secret,token,apikey,authorization,cookie,credential`.
Logged payloads over 16 KB are replaced with `{"truncated": true, "bytes": …}`.
The RPC API (`GetInstance`) still returns variables unmasked, and the
dashboard has no login yet — keep it off public networks.

Definitions deployed without diagram interchange (no `<bpmndi:BPMNDiagram>`,
as hand-written BPMN often is) are laid out automatically with
`bpmn-auto-layout`; ones that carry their own layout, like
`examples/hello.bpmn`, are drawn as authored. Editors such as the BPMN
Modeler extension for VS Code need that layout to show a file at all.

The HTML routes call `ProcessEngine` directly rather than going back through
Connect — same process, no client bundle, no second copy of the domain types.

| Route | Purpose |
| --- | --- |
| `GET /` | overview: definitions, recent instances, live feed |
| `GET /definitions` | definitions page; with `HX-Request`, just the table |
| `GET /instances` | instances page; with `HX-Request`, just the table |
| `GET /services` | registered services: icon, title, URL, protocol, methods |
| `GET /services/:name` | one service: methods and their request fields, which definitions use them, recent calls |
| `GET /events` | events page |
| `GET /definitions/:id` | definition page with its diagram |
| `GET /definitions/:id/diagram.bpmn` | BPMN XML with a layout, for bpmn-js |
| `GET /instances/:id` | instance page: coloured diagram, status, signals, event log |
| `GET /instances/:id/fragment` | the instance page's live part (htmx swaps this) |
| `GET /definitions/:id/elements/:elementId` | inspector for one element or flow: its settings |
| `GET /instances/:id/elements/:elementId` | the same, plus runs, signals, output, variables, taken counts |
| `POST /definitions/:id/start` | start an instance, then redirect to it (`HX-Redirect`, or 303) |
| `POST /instances/:id/signal/:elementId` | signal a waiting activity; answers with the fragment named by `HX-Target` |
| `POST /instances/:id/cancel` | request a cancel (form field `reason`) |
| `POST /instances/:id/retry` | retry a failed instance |
| `GET /events/stream` | SSE stream of engine events as `<li>` fragments, each with its `id`; `?after=<id>` (or `Last-Event-ID`) resumes |
| `GET /health` | `{"status":"ok"}`, for load balancers and the image's `HEALTHCHECK` |
| `GET /favicon.svg` | the brand mark |
| `GET /static/htmx.js` | served from the installed package |
| `GET /static/bpmn-viewer.js`, `/static/diagram-js.css`, `/static/bpmn-js.css` | bpmn-js, same |

Refresh is event-driven: the instances table carries
`hx-trigger="sse:engine, every 30s"`, so anything that moves the engine —
including a change made over the RPC API — updates the page. All tabs share
one stream: browsers allow six HTTP/1.1 connections per server, and a stream
per tab would soon leave none for clicks. The tab holding the
`struna-events` Web Lock keeps the stream and passes events to the others
over a BroadcastChannel; when it closes, another tab takes the lock and
resumes after the last event it saw.

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

### Examples

The examples are Camunda 8 flavoured (`xmlns:zeebe`, `modeler:executionPlatform`)
so Camunda editors open them in the mode struna's templates target.

| File | Shows |
| --- | --- |
| `examples/hello.bpmn` | one user task: start, signal, done |
| `examples/video-render.bpmn` | agentic video render: agents (receive tasks) draft a script, a storyboard and a voiceover in parallel and render the cut; people (user tasks) approve the script with a revise loop, approve over-budget spend, investigate a render that runs over 2 hours (boundary timer), and sign off the release |
| `examples/math-demo.bpmn` | service tasks calling the demo Connect services: add two numbers, halve the sum (reading the previous step's result), branch on it, greet in the start variable's language, and sum it up in a FEEL script task |

In `video-render.bpmn`, every step's documentation says what to signal it
with; an agent reports back exactly like a person does:

```bash
curl -sX POST $BASE/StartInstance -H 'Content-Type: application/json' \
  -d '{"definitionIdOrName":"video-render","variables":{"brief":"60s teaser","budget_usd":100}}'
curl -sX POST $BASE/SignalInstance -H 'Content-Type: application/json' \
  -d '{"id":"<instance-id>","elementId":"draft_script","payload":{"script":"…","scenes":5}}'
curl -sX POST $BASE/SignalInstance -H 'Content-Type: application/json' \
  -d '{"id":"<instance-id>","elementId":"review_script","payload":{"approved":true}}'
```

`test/examples.test.ts` runs it end to end.

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
src/server/dashboard.ts         dashboard routes, SSE feed, asset serving
src/server/diagram.ts           auto-layout for BPMN without diagram interchange
src/server/element-definition.ts  what the BPMN says about one element (inspector)
src/engine/process-engine.ts    API side: definitions, queue starts/signals
src/engine/worker.ts            tick(): claim, run, save, release
src/engine/event-feed.ts        tail of the event log for streams and SSE
src/engine/registry.ts          service registry: descriptor sets and where services run
src/engine/service-call.ts      dynamic Connect/gRPC calls for service tasks
src/engine/templates.ts         element templates for editors, from the registry
src/engine/icons.ts             service icons: files, defaults, monograms
src/commands/templates.ts       `templates export` command
src/engine/bpmn-extensions.ts   Zeebe BPMN extensions: task definition, inputs, FEEL
src/commands/services.ts        `services` command
src/server/registry-routes.ts   RegistryService implementation
examples/services/              demo Connect API (proto + server) for service tasks
src/engine/payload.ts           masking and size cap for logged/displayed data
src/views/*.eta                 Eta templates (`_`-prefixed ones are fragments)
src/gen/                        generated code (git-ignored, run `npm run gen`)
```

## Docker and CI

The image is runtime-only (`node:24-alpine`): CI installs, generates, builds,
tests and prunes, and the `Dockerfile` copies `dist/`, the pruned
`node_modules`, `src/views` and `prisma/` in. No npm install runs inside it.

```sh
docker run -e DATABASE_URL=postgresql://… -p 8080:8080 ghcr.io/strunaio/struna             # serve --worker
docker run -e DATABASE_URL=postgresql://… ghcr.io/strunaio/struna worker                    # a standalone worker
docker run --rm -e DATABASE_URL=postgresql://… --entrypoint node_modules/.bin/prisma \
  ghcr.io/strunaio/struna migrate deploy                                                    # before a new release
```

`GET /health` answers `{"status":"ok"}`; the image's `HEALTHCHECK` uses it.
It listens on `0.0.0.0:8080` (`HOST`, `PORT`).

GitHub Actions (`.github/workflows/main.yaml`) runs on pull requests, `main`
and `v*` tags, built from composite actions in `.github/actions`:

| Action | Does |
| --- | --- |
| `setup` | Node 24 with the npm cache, `npm ci` (which generates the protobuf and Prisma code) |
| `build` | `npm run build`, then `npm prune --omit=dev` for the image |
| `docker` | builds the image (linux/amd64) and pushes it to `ghcr.io/<owner>/<repo>` |

- **`test` job:** proto lint, typecheck and the test suite, against a `postgres:18` service.
- **`image` job:** after `test`, builds the image on every run and pushes it only from `main` (`:main`, `:latest`, `:sha-…`) and tags (`:1.2.3`, `:1.2`).
- **Why `PRISMA_CLI_BINARY_TARGETS` on the `image` job:** the runner's `node_modules` go into an Alpine image, so `npm ci` downloads Prisma's schema engine for both Debian (the runner) and musl (the image). Prisma has no schema or config setting for this.

## Scripts

| Script | Does |
| --- | --- |
| `npm run dev` | `serve --worker` with reload on change |
| `npm run serve` | `serve --worker` |
| `npm run worker` | a standalone worker against `DATABASE_URL` |
| `npm run demo:services` | the demo Connect services for service tasks, on :9000 |
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

- **Own BPMN settings and editor plugins.** Zeebe's own fields first
  (`retries`, `retryBackoff`, `errorExpression`), a `struna:` namespace only
  for what Zeebe cannot express, and a Camunda Modeler plugin later — see
  [docs/editor-extensions.md](docs/editor-extensions.md).
- **Service calls.** Service tasks call services inline, with no job queue.
  Saving after each call, long-running operations (AIP-151) and retries are
  planned in [docs/service-calls.md](docs/service-calls.md).
- **Service metadata from the proto.** Doc comments as template help, and
  optional `struna.v1` options (title, icon, field labels, `sensitive` for
  masking) under the registry's own settings, are planned in
  [docs/service-metadata.md](docs/service-metadata.md).
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
