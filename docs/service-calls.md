# Service calls: durable, long-running, retried

Status: step 1 implemented (2026-09-25); steps 2 and 3 are design. Replaces
the earlier jobs sketch.

## Where we are

A service task calls a registered Connect method inline, inside the
instance's run (`serviceTasks` in `src/engine/worker.ts`, `callMethod` in
`src/engine/service-call.ts`):

- The call has a 25 s timeout, so it fits the 30 s run limit.
- A run continues through as many steps as it can before it parks. In `examples/math-demo.bpmn`, Add, Halve, Greet and Summarize all happen in one run.
- A failed run is thrown away whole. Its state is not saved, and **Retry** resumes from the last saved state.

This model stays: Struna calls services itself and has no job queue. The
work below makes it durable, lets calls take as long as they need, and adds
the per-task settings Zeebe has.

## Decision: no jobs

Zeebe-style jobs (a `jobs` table, job workers, `ActivateJobs` / `CompleteJob`)
were sketched and set aside. With only Struna's own service calls:

| Need | Solved by |
| --- | --- |
| Finished calls must not repeat | 1. Save after each call |
| Calls that run for minutes or hours | 2. Long-running operations |
| Slow services must not tie up workers | 2. Long-running operations |
| `retries`, `retryBackoff`, `errorExpression` | 3. Retries and errors |
| Incidents with state kept | 1 and 3 together |

Jobs would only be needed for **external workers**: code in other languages
that pulls work from Struna. Revisit then. The BPMN would not change, since
the job type is the `zeebe:taskDefinition type` either way.

## 1. Save after each call (implemented)

**Problem.** Because a failed run is thrown away whole, a failure in a later
step repeats every call made earlier in the same run. If Greet fails, Retry
calls Add and Halve again. That's harmless for a calculator, and wrong for a
service that charges a card or sends an email.

**Change.** After a service call succeeds and its result is applied, the
worker saves a checkpoint before the run continues:

- **Saved:** the engine state and variables, in one transaction that also removes the signals the run has applied so far from the inbox. The lease is kept, and events are logged as they happen, as before.
- **When:** the snapshot is taken as soon as the engine has settled after the call (its result applied, the next steps started), and only the write is queued. A step that fails while an earlier checkpoint is still being written therefore doesn't cost the progress made before it.
- **Result:** a later failure resumes from the last checkpoint, so only the failing call repeats.
- **Cost:** one extra write per service call. Script tasks, gateways and events don't checkpoint; they have no side effects.

**Guarantee.** Calls are at least once, never "every earlier call again". A
worker can still crash between a call returning and the checkpoint being
written; that call then repeats. Services see the `struna-instance-id` and
`struna-element-id` headers (already sent) and can deduplicate with them. A
per-attempt idempotency key header, instance + element + run, is a small
addition.

## 2. Long-running operations (AIP-151)

For work that takes longer than a call should, a service follows Google's
long-running operations pattern
([AIP-151](https://google.aip.dev/151)), which many gRPC APIs already use.

**Contract.** The method returns `google.longrunning.Operation` and declares
what it will eventually produce:

```proto
import "google/longrunning/operations.proto";

service RenderService {
  rpc Render(RenderRequest) returns (google.longrunning.Operation) {
    option (google.longrunning.operation_info) = {
      response_type: "RenderResponse"
      metadata_type: "RenderMetadata"
    };
  }
}
```

The service also serves the standard `google.longrunning.Operations` service
(`GetOperation`, `CancelOperation`) at the same base URL. Its descriptor set
includes `google/longrunning/operations.proto`; `buf build` bundles imports.

**Flow.**

1. **Call.** Struna calls `Render` and gets back `{ name: "operations/abc", done: false }` straight away.
2. **Park.** Struna stores the operation name on the step, saves a checkpoint (section 1), and parks the instance with `runnableAt = now + poll interval`. That's the same way a timer parks it, so no worker is held while the work runs.
3. **Poll.** Each time the instance wakes, Struna calls `Operations/GetOperation(name)`. While the operation isn't done, it parks again with a growing interval: 1 s, 2 s, 4 s … up to 1 min.
4. **Done.** It then handles the outcome:
   - **`response`:** unpacked to `response_type`, then applied exactly as a direct response: output mappings, `resultVariable`, `resultExpression`.
   - **`error`:** handled like a failed call, so section 3 applies.
5. **Cancel.** If the instance is canceled, or an interrupting boundary event (for example a timer) leaves the task, Struna calls `CancelOperation(name)`. The call is best effort.

**Detection.** A method is long-running when its output type is
`google.longrunning.Operation` and it has `operation_info`. Deploy checks
refuse an `Operation` method without `operation_info`, since Struna could not
decode its result. No BPMN setting is needed.

**Settings** (task headers, following the Zeebe-fields-first rule in
[editor-extensions.md](editor-extensions.md)):

- `pollInterval`: the first interval, ISO 8601 (`PT5S`). Default `PT1S`, doubling up to `PT1M`.
- `operationTimeout`: give up after this long (`PT2H`), which counts as a failed call. Default: no limit.

**Templates.** Output fields come from `response_type`, so the editor offers
the final result's fields (`Map video_url to`), not the Operation wrapper.
Result expressions see `response` as the unpacked `response_type`.

**Inspector.** While the operation runs, the step shows:

- the operation name;
- when it was last polled and when the next poll is;
- `metadata`, decoded to `metadata_type`, such as progress.

Events: `operation.start`, `operation.poll` (only when `metadata` changes),
`operation.done` and `operation.cancel`.

**Later: push instead of poll.** When done, a service could send a message to
the instance over the existing signal/message path, and Struna would poll only
as a fallback. Polling stays the default, since it needs nothing beyond the
standard.

## 3. Retries and errors

These use the Zeebe and connector fields (see
[editor-extensions.md](editor-extensions.md)):

| Setting | Field | Default |
| --- | --- | --- |
| Retries | `zeebe:taskDefinition retries="3"` | 3 (Zeebe's default) |
| Retry backoff | task header `retryBackoff` (`PT10S`) | `PT0S` |
| Error handling | task header `errorExpression` | none |

**Retries.**

- When a call fails (or an operation ends in `error`, or `operationTimeout` passes), Struna uses up one attempt.
- While attempts remain, it saves a checkpoint and parks the instance with `runnableAt = now + retryBackoff`. The next claim repeats only that call.
- The attempt count lives in the step's saved state and resets when the task ends.

**Error expression.** This is the connector convention, evaluated after the
call:

- over `error` (`{code, message}`) when the call failed;
- over `response` when it succeeded.

A result of `bpmnError(code, message)` throws a BPMN error, so an error
boundary event on the task catches it. `null` falls through to the normal
handling: success, or a retry.

**Out of attempts: an incident.**

- **What happens:** the instance stops **at the task** with its state intact, thanks to section 1. It gets a new status, `incident`, not `failed`, so the dashboard can tell "stopped at a task, fixable" from "the run broke".
- **Retry:** the dashboard's Retry (and `RetryInstance`) gives the task one more attempt, or a given number, and wakes the instance. As in Operate, the operator can also change variables before retrying.
- **Everything else still fails the run:** a FEEL error, an unregistered method or a bad request.

**Templates.** They gain the connector templates' two groups:

- **Retries:** `retries`, `retryBackoff`;
- **Error handling:** `errorExpression`.

## Steps

1. **Save after each call — done.**
   - **Code:** `#checkpoint` in `InstanceRun` and `Worker` (`src/engine/worker.ts`).
   - **Test:** "a failed call repeats alone on retry" in `test/services.test.ts`.
2. **Long-running operations.**
   - Add a demo `RenderService/Render` to `examples/services` that finishes after a few seconds and reports progress in `metadata`.
   - Detect long-running methods, park and poll, cancel, and decode the response and metadata.
   - Show the operation in the inspector, and build templates from `response_type`.
3. **Retries and errors.** Add `retries`, `retryBackoff`, `errorExpression`, the `incident` status and Retry for incidents, plus the two template groups.
4. **Later.** Push completion instead of polling, and jobs if external workers are ever needed.
