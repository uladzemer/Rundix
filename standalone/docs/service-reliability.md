# Service task recovery

Implemented in 0.4.2; validation uses synthetic CLI/provider children. This is
not evidence that an already running service has loaded the update.

## Failure paths and corrections

| Trigger | Previous failure | Correction / owning source |
| --- | --- | --- |
| Known exhausted limits before send | `send-queue.cjs` refused before service admission could ask the installed provider | The service transport owns admission; the common send path delegates this check to it. Ordinary window quota checks remain active. |
| Typed `usageLimitExceeded` during a turn | Generic failed turn, without a continuation intent | `service-headless-host.cjs` records typed evidence; `mcp-tasks.cjs` waits for terminal/confirmed CLI exit and records one fixed continuation keyed by exhausted turn ID. |
| Replacement CLI during admission/probe | A thread loaded on the prior child was sent directly to the replacement | The host invalidates loaded session state on generation change; a changed child reads/resumes the existing thread before dispatch. |
| CLI exit before start ACK | Exit handling could overwrite the pending limit wait or retain its old readiness budget | Preserve the pending wait and reset only its next connection attempt budget. Unknown input delivery is never automatically replayed. |
| Task record lags its saved session | `chatId:null` was treated as missing chat while the saved session already had a thread | Persist thread identity before admission; reconcile saved session identity before deciding whether execution was unsent. A task with neither a session thread nor a dispatched model request reaches a definite terminal state without polling the CLI. |
| Failed status read | Repeated scheduler reads and unconditional saves changed revisions without new evidence | Service reads use 1/2/4/8/16-second backoff, then retry every five minutes. Slow recovery does not consume a parallel execution slot. Explicit `continue_task`/window Continue or cancel resets the budget. History includes connection failures in the same budget, coalesces concurrent calls and releases temporary subscriptions. |
| Lost completion / stale completion | A live flag could remain forever, or a stale turn could release the current turn's ownership | Service reconciliation reads thread metadata and the last turn after a generation change, restart or two minutes without events, with 30-second timeouts. It runs independently of scheduling; read timeouts keep healthy tasks running. Terminal evidence releases the owning provider grant. Service session completion handling rejects a different turn ID. |
| Restart or CLI exit before dispatch | Previous-turn terminal evidence could erase a proven unsent continuation | Durable `preparing` input takes precedence over terminal evidence; ordinary and automatic continuations survive. A terminal refusal preserves queued user text in `unsentInputs`. |
| Long task queue | A 120-second readiness budget began at task creation, so the first actual attempt could already be expired | `service-readiness.cjs` starts the durable budget on the first connection attempt. Queue time and quota waiting do not consume it. |

After confirmed limit termination, the service records exactly:

> Continue the task from where you stopped.

It sends this before queued clarifications, in the same thread, after a fresh
provider admission. It never replays the original task text. A cancelled unsent
automatic continuation is removed. `waiting_limit` retains its thread and
directory reservation while releasing the execution slot. Reset time alone is
not authorization: the shared limit poller must obtain a fresh provider result.
There are at most two consecutive automatic limit continuations, at least 60
seconds apart. A successful non-limit turn resets this budget. At the cap, the
task retains the provider reset wait or exposes `action_required` for explicit
inspection and Continue. Status failure keeps user input queued.

All new recovery/backoff, last-turn error/ID hydration and completion filtering
are service-only. Ordinary window behavior remains the 0.4.1 behavior; its
original release and defect regression tests run unchanged. Replacement CLI
thread resumes use the same MCP and preflight configuration as ordinary sends.

Account selection, candidate scanning and rotation remain exclusively in the
installed private provider. The generic `turnTerminal` lifecycle notification
may carry `limitReached:true` after typed CLI evidence; it carries no account
selectors or credentials. Confirmed CLI exit preserves this evidence too.

Existing diagnostics containing only `cli_read_failed` cannot identify the RPC
method or the precise underlying provider refusal retroactively. New diagnostics
allow only fixed method names and fixed provider codes, without RPC parameters,
thread IDs, input, error messages or paths.

## Regression evidence

- `test/service-task-reliability.cjs`: typed mid-turn failure, durable reset wait,
  fixed same-thread continuation then FIFO, legacy missing task chat ID,
  chat-less cancellation/recovery, bounded task/history reads, explicit Continue,
  service restart and a task queued for ten minutes.
- `test/service-recovery.cjs`: multiple grant cleanup after confirmed child exit,
  stale read fences, re-authentication, provider replacement and no input replay.
- `test/service-cold-start.cjs`: durable retry budget, expired/hung attempts,
  quota-wait budget reset and cancellation after model dispatch.
- `test/service-review-regressions.cjs`: unchanged window behavior, lossless
  queued input, restart with ordinary/automatic preparing intent, generation
  changes/configuration, CLI exit before dispatch, repeated limit bounds,
  nonblocking lightweight status timeouts, slow recovery slots and concurrent
  archived history retries/unsubscribe.
- Private integration tests use this public worktree through
  `RUNDIX_PUBLIC_STANDALONE`; public fixtures contain no account pool logic.

Live acceptance remains separate: load both updated editions during an owner
maintenance window, then confirm same-chat continuation at a real usage limit
and explicit Continue on previously interrupted tasks. Building or testing a
package does not restart or repair the owner's running service.
