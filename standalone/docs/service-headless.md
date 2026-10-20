# Headless service implementation status (step 3a, partial)

The public service is not wired or installed yet. Window-owned MCP remains the
default and only selectable mode. Do not advertise this slice as a working
headless service. No real CLI account or sign-in files are used by its tests.

## Space identity

`runtime/service-space.cjs` implements stage-1 D06-D09:

- `launchBinding({env?, cwd?})` captures a validated canonical launch directory,
  its source (`claude_project_dir` or `cwd`) and the computed space. Non-empty
  invalid `CLAUDE_PROJECT_DIR` fails closed, with no cwd fallback.
- `resolveSpace(launchDirectory)` returns `{kind, root, spaceId}`. The future
  service must recompute this at hello rather than trust a client-supplied ID.
- Filesystem-only git discovery bounds ancestry (256), metadata reads (4 KiB),
  and common-directory chains (8). Linked worktrees share the main repository's
  space; nested repositories and non-git launch directories remain independent.
- Canonicalization is shared with `task-directory.cjs` (native realpath,
  normalized Windows DOS/UNC aliases and lowercase). Execution reservation keys
  retain their existing algorithm: a worktree's own `.git` remains a separate
  execution boundary even when its launch space is shared.
- Errors carry safe protocol codes, never filesystem exception messages.

`test/service-space.cjs` is synthetic and runs in `npm test`. Windows checks cover
case, DOS extended prefix and junction equivalence. Native macOS remains untested.
The resolver is excluded from the VSIX until its service callers are implemented;
the actual ZIP audit enforces that exclusion.

Validation of the space slice: `npm.cmd test`, Extension Host suites
`mcp-host.cjs`, `startup-host.cjs`, `local-auth-host.cjs`, and `npm.cmd run package`
passed on Windows. The ZIP's identity, changed canonicalization source, README
and icon bytes were checked against the workspace; the VSIX was deleted. A
separate read-only review found an overly broad GLOBALROOT check; it was fixed
and the focused second review reported zero remaining confirmed findings.

## CLI safety boundary

`runtime/service-cli.cjs` exports `ServiceAppServer`, a service-only facade over
the existing `AppServer`. It has no raw `write` or child-process handle. It is
not the provider-v2 implementation and is not used by the window host.

- Constructor authority supplies `serviceGeneration`, `configRevision` and
  `providerGeneration`. Each new child receives fresh app-server identity and
  generation, with an initially closed model gate.
- Startup appends `-c cli_auth_credentials_store="ephemeral"`, preserves normal
  `CODEX_HOME`, removes credential environment overrides, and accepts only the
  existing fixed user-input feature override. Other launch config overrides
  are rejected. No authentication files are read, copied or changed here.
- An explicit method allowlist excludes logout, persistent login and config
  writes. Model-producing start/steer/compact requests require the gate; a
  personal `account/read` result never opens it.
- `authenticateProvider(callback, {leaseId, leaseRevision, timeoutMs?})` is a
  **trusted service integration seam**, not a wire method. The future v2 owner
  must validate config/child/idle grants before calling it. The callback receives
  `{fence, request}` and may request only external `account/login/start`,
  `account/read`, `account/rateLimits/read`. It must both complete external login
  and return `{kind:'authenticated', accountRevision, fence}` for that binding.
  New revision is current+1; repeat login may echo a current nonzero revision.
- Provider timeout/loss closes the gate. An outstanding/ambiguous login
  quarantines the generation until process restart, preventing a late login
  from changing the account behind a newer proof. Old callbacks cannot open
  or close a later generation's gate. Authentication is bounded to 70 seconds.
- `invalidateProvider()` closes the gate on provider/config lineage changes;
  the future service must invoke it. `dispose()` requests shutdown; a later
  `start()` waits for confirmed child close, up to five seconds, otherwise
  `recovery_required`. An already dispatched request remains delivery-uncertain
  across generation loss and must not be automatically replayed.

This login gate is necessary but **not sufficient** for dispatch. The provider
driver below adds per-turn admission and refresh; service/session-core wiring,
durable intent/reconciliation and persisted child recovery are still outstanding.
`beginProviderTransaction` extends the original login seam for an idle prepare
which may log in or reconnect. New account IDs require revision+1; repeat login
of the confirmed account may echo current. Only the account ID is retained in
volatile transport state, never tokens, files or diagnostics. Service-installed
turn authorization cannot be replaced. Refresh requests have one claimed owner
and a dedicated fenced `respondProvider`, without opening the model gate.

`test/service-cli.cjs` uses a real synthetic Node child (`fake-service-cli.cjs`)
and runs in `npm test`. It verifies argv/environment, no logout/config writes,
proof/fence/revision rejection, stale callbacks, ambiguous login quarantine,
restart/loss gates, confirmed-exit barrier and turn delivery uncertainty. It does
not verify actual CLI credential persistence; bounded real-CLI evidence is in
`cli-external-auth-verification.md`. The facade is also excluded from the VSIX.

Validation of the final CLI slice: `npm.cmd test`, `npm.cmd run package` and
`git diff --check` passed. The final ZIP identity/README/icons/changed source
were checked, both unwired modules were confirmed absent, and the VSIX was
deleted. Separate read-only review found lost delivery uncertainty after CLI
replacement; it was fixed with a delayed-turn regression. Focused second review
reported zero remaining confirmed findings. No real CLI or inference was used.

## Public provider v2 (Node-only, not installed yet)

`service-provider-config.cjs` reads only the user-level
`rundix-service/provider.json`: `%APPDATA%/Rundix/rundix-service/provider.json`
on Windows, `~/Library/Application Support/Rundix/rundix-service/provider.json`
on macOS, `~/.config/Rundix/rundix-service/provider.json` on Linux. A trusted
test-only `configPath` override isolates synthetic tests. Workspace/settings/env
do not select a provider. Missing config fails closed with
`PROVIDER_NOT_CONFIGURED`; invalid config/install with `PROVIDER_CONFIG_INVALID`.
Both include `reason:"action_required"` and a fixed companion-settings action.

Owner's manifest decision (2026-10-20) extends **ProviderConfigV1** with a
top-level absolute `manifestPath`. Existing protocol field names are retained:
`provider.entryPath`, `provider.manifestSha256`, `provider.protocolMajor`.
The complete shape is:

```json
{"schemaVersion":1,"configRevision":7,"manifestPath":"C:\\Synthetic\\Provider\\1.0.0\\provider-manifest.json","provider":{"id":"synthetic-provider","protocolMajor":2,"version":"1.0.0","entryPath":"C:\\Synthetic\\Provider\\1.0.0\\provider-entry.cjs","manifestSha256":"<64 lowercase hex>"}}
```

`provider-manifest.json` lives beside the entry, in its versioned install dir:

```json
{"schemaVersion":1,"providerId":"synthetic-provider","providerVersion":"1.0.0","protocolVersion":1,"entry":"provider-entry.cjs","entrySha256":"<64 lowercase hex>"}
```

`protocolVersion:1` is the manifest/install contract; `provider.protocolMajor:2`
and hello major 2/minor 0 are the provider RPC contract. Config hashes the exact
manifest bytes; manifest hashes the exact entry bytes. All fields are checked,
including matching ID/version, absolute local paths, fixed manifest filename,
leaf `.cjs` entry with no separators or `..`, and realpath containment. Symlink
components/escapes fail closed. JSON duplicates/unknown fields are rejected.
Config/manifest are bounded to 16 KiB, entry to 16 MiB. POSIX ownership and
0700/0600 privacy are checked; Windows ACL checks allow only current SID and
SYSTEM and do not change permissions. **Digests detect inconsistency/corruption;
they do not protect against same-user tampering or authenticate dependencies.**

`service-provider-rpc.cjs` / `service-json.cjs` implement uint32-BE-length-prefixed
UTF-8 JSON-RPC (256 KiB/frame, 32 total unsettled calls, 1 MiB output
queue, 5 s partial-frame/write timeout, nesting depth 16). Batch, duplicate keys, non-UTF-8 and
invalid envelopes close the connection. Requests use top-level `fence` and
`timeoutMs`; request/event/error fences are top-level. Successful results contain
their fence inside `result`. Method payload is `params`; callback `owner` is
`{leaseId}`. Errors use numeric JSON-RPC codes and fixed public names in both
`error.message` and `error.data.code`. IDs are nonempty strings up to 128 chars;
the cap of 32 counts outgoing and incoming work together.
Errors contain only fixed codes. RPC deadline closes the peer and aborts callback
delivery; timed-out application work is not treated as completed. No stderr,
credential record, chat input or personal path is sent to diagnostics.

`service-provider.cjs` exports `ServiceProvider`:

- `start()` validates the installation before hidden, shell-free child Node
  spawn and negotiates every method/event in `service-provider-contract.cjs`.
  `authority` supplies the global fence for `createCli(options)`; its facade
  installs a non-replaceable model-send authorizer. A raw facade `turn/start`,
  steer or compaction cannot bypass admission.
- `authenticate(trigger)` holds a service-issued idle grant for the entire
  login transaction. CLI callbacks must reference the live parent's RPC ID;
  `owner.leaseId` equals its binding leaseId, and `binding` and wire fence must match.
  Only external login/read/limits are allowed. An idle `cli/reconnect` waits for
  confirmed old CLI exit, issues a new idle grant/generation and returns its
  binding. `effectiveBinding` is accepted only from that recorded transaction.
- A successful external-login callback receives the CLI's result plus the
  service-issued provisional `authGrantId` and `nextAccountRevision`. An idle
  prepare which changes account uses those in its ready outcome. A grant is
  activated only after the fenced provider outcome confirms login/revision.
  Repeat login of the same epoch retains its current account grant.
- `prepareTurn(task,{mode:"admit"|"probe"})` forces
  `interactiveClientAvailable:false` and serializes preparation. Probe never
  reserves a turn. Ready admit validates the account grant and expiry, then
  reserves a child turn grant **before dispatch**. `dispatchTurn(grant,params)`
  consumes only that exact reserved grant; ACK emits `turnStarted`.
- Waits keep their waitId across probes. Retired waitIds are never reused during
  the service lifetime; cancel is idempotent for the owning task/space, with a
  post-await wait fence preventing a late prepare from resurrecting cancellation.
  Task-state `waiting_limit` projection/shared poller are the next wiring slice.
- `terminal` requires exact task/run/turn/lease identity and a trusted confirmed
  terminal/CLI-exit trigger. Provider loss/timeout closes login proof and
  admissions but retains active/uncertain turn grants. `releaseReserved` handles
  a proven unsent reservation. Persisted child ownership/recovery must be supplied
  by the service entry; a lost provider instance is never silently restarted.
- Typed `account/chatgptAuthTokens/refresh` is routed to `handleRequest` without
  the admission mutex/idle grant. The exact outstanding request is claimed once;
  only its fenced `cliResponse` for the confirmed account (or in-flight login
  target) can answer it. A different account closes proof and retains active
  leases. No callback sends model input.
- `configureByClient` checks selection CAS and holds an idle grant for its RPC.
  Pending configuration blocks admission, closes proof, and stays busy until
  `status(operationId)` confirms succeeded/failed. Uncertain remains blocked.
  Resuming requires explicit authentication. Status is projected to fixed enums,
  operation IDs, public codes and numeric method counters; arbitrary payload is
  rejected. `dispose` drains only without active/preparing turns.

Synthetic tests `service-provider-config.cjs`, `service-provider-rpc.cjs` and
`service-provider.cjs` run in default `npm test`. The child fixture is test-only;
it uses synthetic account labels and never touches auth files or network. Tests
cover config/digests/permissions, framing limits, login proof, grants, wait/cancel
races, stale parent/owner, new-account revisions, independent refresh during a
blocked prepare, reconnect, pending configuration, config changes, and provider
loss retaining a live turn. All new runtime modules remain excluded from VSIX
until service integration; the ZIP audit asserts their absence.

Provider-slice validation: focused config/RPC/provider/CLI suites, full `npm test`,
the synthetic `mcp-host`, `startup-host`, `local-auth-host` Extension Host suites,
and packaging/actual-ZIP audit passed on Windows. Separate read-only review used
three rounds: retired waitIds, changed-account revisions and foreign-account
refresh were fixed with synthetic regressions; the final focused round reported
zero remaining confirmed findings. Numeric-ID compatibility was subsequently
replaced by the tighter string-ID contract in the wire cross-check below.
No real account, sign-in file, CLI or inference was used. Native macOS remains
unverified. Final validation after the local commit is recorded in the task report.

## Generic wire cross-check (2026-10-20)

Only the companion's integration protocol notes were read. No private code,
identifiers, account selection, storage, broker or rotation policy is incorporated
here. These findings compare documented shapes, **not** a live interop run.
The original normative prose does not settle every concrete payload choice.

| Mismatch found | Resolution / side that should change |
| --- | --- |
| Public success `fence` top-level vs companion `result.fence` | Public transport changed to `result.fence`; raw-wire tests added. Requests/events/errors retain top-level fence. |
| Public string `error.code` vs numeric error + `message`/`data.code` | Public transport changed to numeric JSON-RPC error with fixed public name in both fields. |
| Public hello `providerVersion` vs companion `version` | Public hello now sends `version`; result still uses `providerVersion`. |
| Public depth 64, numeric IDs, unbounded string IDs, 32 per direction vs companion depth 16/string 1–128/32 total | Public provider framing now uses the companion's tighter bounds. Config parsing retains its separate bound. |
| Public callback string `owner` vs `{leaseId}` | Public callbacks now require `{leaseId}`; synthetic fixture updated. |
| Public login/reconnect callback missing `idleGrantId` | Public now requires the exact live idleGrantId for both mutations. |
| Public raw CLI callback result vs `{response,fence}` | Public now returns nested `response`, with callback fence inside result. The existing public `authGrantId`/`nextAccountRevision` login result extensions remain; these are retained as part of the current public contract. |
| Public reconnect `{binding}` vs `{confirmedExit,effectiveBinding,fence}` | Public result now uses `confirmedExit:true`/`effectiveBinding`; original callback fence is inside result. Binding-transition ordering remains different (below). |
| Public status `{status,counts?}` vs `{authenticated,activeTurns,preparing}` | Public status validates/projects the three companion fields; optional numeric method `counts` remain a synthetic diagnostics extension. |
| Current public nested grants, idle/account binding lifecycle, opaque generation, terminal payloads | Retained unchanged. Owner correction: the private provider now follows the current public contract; the former item-6 reshaping is cancelled. |
| Candidate scan login followed by waitUntil/unavailable | Public driver now accepts validated prepare outcomes after login and routes them through the existing task-state table. Quota waits retain confirmed login evidence but create no turn grant; action-required closes the turn gate. |
| Refresh provider refusal | Implemented below: fixed error response, account invalidation, no refresh replay. Arbitrary diagnostic/credential payloads are never forwarded or logged. |

The owner reports that the private provider now passes integration against the
current public ServiceProvider/ServiceAppServer. This repository's checks remain
synthetic; that external result is not represented as a locally repeated check.
Nested grants, opaque generation and existing callback envelopes remain the public
contract from 7f358b8/23cb9ba. No item-6 shape changes were implemented.

## Headless host (item 2)

`service-main.cjs` acquires the existing IPC singleton before creating the host.
Only the winner constructs `service-headless-host.cjs`, `createSessionCore` and
`createMcpHost`. The root comes from `service-endpoint.locations` (test override
isolates discovery and endpoint). At this checkpoint task RPC is deliberately
unsupported until space-bound dispatch in item 3; there is no unscoped network
task API or HTTP bridge. The Node entry is not yet installed or launched by the
extension/adapter. Window mode remains unchanged.

The host reads bounded plain `settings.json` under the service root with only
`mcpAccessMode`, `mcpMaxParallelTasks`, `mcpThreadConfig`, `cliPath`. KV records
live in `state/` through atomic SessionStore writes, sessions in `sessions-v1`,
and current McpTasks records in `mcp/tasks`. Provider configuration stays at its
separate user-level path. Existing McpTasks recovery semantics are retained.

Core transport delegates to `ServiceProvider` and its `ServiceAppServer` facade;
both children start lazily. Each turn maps its thread to the service-owned task,
receives a fresh provider admit and exact grant, then dispatches through the
driver. Completion-before-ACK is buffered before releasing the exact turn grant.
If ACK is lost, driver-observed typed start and matching completion can prove
terminal without replay. Unmatched completion is ignored before changing run
identity, including an old completion buffered before dispatch rejects.
Refresh stays owned by the driver, never duplicated by core request handlers.
No editor/IDE selection, tab, notification or completion UI is invoked. Reload
reports unsupported; closing a terminal headless task reports no UI tab closed.

Diagnostics accept only fixed event codes plus numeric timestamps, never raw
messages/paths/chat/auth records, and rotate at 1 MiB across three files. Idle
exit counts IPC work, clients, all nonterminal tasks, recovery and provider work;
it cannot dispose a busy host. A connected client resets the idle period.

`test/service-headless-host.cjs` uses real core/executor/driver with a framed
synthetic provider child and `fake-headless-cli.cjs`, checks report/continuation,
same chat ID, no-UI close/reload, settings/KV/session files, safe diagnostics,
singleton loser and real-IPC connected-client/idle exit. It runs in `npm test`.
Item 4 includes these modules in the VSIX behind the experimental user setting.

Review of item 2 used three read-only rounds. The reviewer reproduced a retained
grant after lost ACK, then stale-event poisoning and a buffered timing variant.
The final author fix validates typed terminal candidates immediately through the
driver, retains bounded ACK candidates, and never overwrites confirmed identity
with an unvalidated event. Both 5 ms and 80/120 ms stale-event/ACK regressions pass.
This last correction was author-verified after round 3; it is not represented as
an independent approval of the final diff. Further review was not requested.

## Space task RPC and shared limits (item 3)

`service-task-rpc.cjs` binds an adapter connection during authenticated hello by
recomputing `resolveSpace(binding.launchDirectory)`. The immutable reply contains
bindingId/spaceId, toolSchemaVersion:1 and tasks.v1/limitWait.v1 capabilities.
Every `task.call` carries bindingId/spaceId as well as the IPC generation.
Only that space's tasks are visible, including mutations and idempotency search;
dedup keys are `(spaceId,requestId)`. Ownership precedes provider or operation
lookup. Mixed foreign wait IDs fail as a whole with unknown_task. Execution
projectDirectory may belong to a different repository. A disconnected long poll
is detached without cancelling its task. Domain errors use fixed safe envelopes;
missing/invalid provider returns action_required plus the provider's public code.

McpTasks now accepts optional scope/signal hooks; window hosts omit both. Durable
task records carry space; existing storage/recovery mechanics remain in place.
`waiting_limit` retains the unsent input and directory reservation, frees execution
and credential slots, and is not a waking state. wait_task/wait_tasks return a
timedOut checkpoint at client deadline or a future resetAt, including waitingLimit
or waitingLimits. Progress/revision changes and entering waiting_limit do not
wake them. Cancelling a wait is saved before provider cancellation; an explicit
continuation after cancellation allocates a new wait identity.

`service-limit-poller.cjs` owns one in-flight probe and a shared unknown backoff
1/2/4/8/15 minutes, honoring retryAfterMs as a lower bound. Tick defaults to 15 s;
known reset and idle turn completion trigger fresh probes/admissions. Unchanged
quota results do not bump visible revisions. Provider action-required errors
wake tasks as errors while preserving unsent input. `service-task-rpc.cjs` tests
real IPC isolation and wait/cancel behavior; `service-limit-poller.cjs` tests 100
waits sharing one probe, backoff, deadlines and unchanged revisions.

Separate read-only item-3 review found the retired waitId continuation bug; it
was fixed with a real-IPC regression. Reviewer reran both suites and reported
zero remaining confirmed findings. No real account or CLI was used.

## Remaining work for 3a

Grant-lifecycle reshaping was cancelled by the owner. Existing McpTasks recovery is retained; additional
durable intents/recovery are deferred. Window
projections/migration belong to 3b; real Windows scenarios belong to 3c. Private
provider implementation, credential storage and rotation stay outside this repo.


## Experimental service adapter (item 4)

`rundix.mcpService` is an application/user setting, `window` by default. Only
`inspect(...).globalValue` is read, once per activation; reload after changing.
In `service` mode this window never starts its MCP bridge/executor or selects a
window companion for MCP. Manual chats retain their existing connection API.
The panel displays a background-service note and configuration controls; task
projection belongs to 3b. The Stop MCP command disables this window's launcher controls;
it does not interrupt service tasks or other clients. The service exits when idle.

Start MCP installs a stable `<serviceRoot>/bin/mcp-server.cjs` shim, an atomic
private `installation.json`, and a versioned installed runtime copy under
`versions/`. Identical installed runtimes are reused by content hash. While an owner is published no versions are pruned; idle installations keep the current runtime and two recent copies.
Registration names absolute `nodePath`, `entryPath`, `adapterPath`; workspace input
cannot select an executable. Replace only the Rundix Claude MCP entry with the
configuration shown by the window and restart the adapter. No automatic edit of
Claude configuration, legacy migration, or window task projection is performed.

`service-adapter.cjs` preserves launch cwd/env, resolves the immutable launch
space, probes ownership, starts absent/dead owners detached with a hidden Windows
window, then waits for authenticated ready IPC within the startup budget.
Responding/starting owners are reused. Hung/unverified owners are never killed.
The stable launcher supports --wait/--timeout/--brief; --recover-hung currently
fails closed (verified child-process tree recovery remains deferred). Old HTTP
--bridge configuration still selects window mode and must be replaced explicitly.
No task call is replayed after timeout/disconnect; reuse requestId explicitly.
Tools are negotiated from hello capabilities; service list_tasks adds waiting_limit,
reload_window is omitted, and limit waits retain their non-waking semantics.

Service runtime modules now ship in the package; audit verifies inclusion and
relative require closure. Synthetic fixtures remain excluded. Installation,
space negotiation, user-only selection and default-window compatibility have
synthetic/isolated-host coverage; panel checks cover both languages/themes/widths.

Item-4 independent read-only review found the explicit-default-root endpoint
split, split startup budget and read-only waiter reconnect error mapping. All
three were fixed; the reviewer reran adapter and IPC suites and reported zero
outstanding confirmed findings. Visual inspection then changed the service note
to inherit theme text/background and corrected its copy button label.


## Full synthetic transport path (item 5)

`test/service-e2e.cjs` runs by default in npm test. It installs the actual stable
launcher/runtime into a synthetic root, starts two stdio MCP adapter children,
and races their first negotiated tools/list calls to demand-start a separate
service process. A test-only registered entry injects the synthetic provider
and fake app-server; no production auth/files/accounts or network are used.

Both adapters use real framed/authenticated service IPC. Their launch roots
are synthetic Git repositories (one selected through CLAUDE_PROJECT_DIR); each
submits execution into the other repository with the same requestId. Assertions
cover separate task identities/lists, all foreign single-ID operations and a
mixed wait set, completion reports, same-chat continuation, headless close,
missing provider -> action_required without persisted submission, ephemeral CLI
argv, connected-client idle suppression and actual process exit after disconnect.
Existing service-cli tests additionally enforce no logout and login-generation
gates; existing RPC/poller suites cover waiting_limit, cancellation and checkpoints.

Item-5 read-only review reported zero outstanding confirmed findings and reran
the end-to-end test. After one intermittent startup timeout, author inspection
found that the initial 150ms test idle interval could expire within discovery's
1s backoff; the fixture now uses 2s and verifies connected-client suppression
for longer than that interval. Production idle timing remains five minutes.


## Candidate scan outcomes after login

A prepare transaction can successfully log in one or more candidates and still
return waitUntil or unavailable. These outcomes have no accountRevision field.
For validated quota waits the driver derives the confirmed revision internally
from its CLI login transaction (same account retains revision; changed account
advances it), promotes the existing nested account grant, and returns the outcome.
No turn grant is created. Action-required outcomes do not promote the login proof.
Malformed waits, unsupported outcomes and invalid revisions still fail closed.

Synthetic provider cases cover same/changed account, waitUntil, every unavailable
code and malformed wait identity. Real-IPC task tests verify waiting_limit versus
error/action_required, no wake before wait timeout, no active grant, and cancellation.


## Refresh refusal forwarding

A successful handleRequest result may contain
`{kind:"cliResponse",requestId,response:{code:"AUTH_REQUIRED"|"AUTH_REVOKED",messageKey:string}}`
instead of token fields. Only these refusal fields are allowed, never mixed with
accessToken. The requestId must match, including its original numeric/string type.
The existing unavailable outcome is also a refusal. RPC/pre-check failures map to
PROVIDER_PROCESS_UNCERTAIN when no supported public unavailable code is available.
The existing RPC framing and nested grant/callback shapes are unchanged.

The CLI receives a JSON-RPC error with a fixed message and public code in
`error.data.code`; numeric mappings are AUTH_REQUIRED=-32001, AUTH_REVOKED=-32002,
PROVIDER_PROCESS_UNCERTAIN=-32003, other supported unavailable codes=-32000.
Provider messageKey/text is never rendered, logged or forwarded. The outstanding
refresh is consumed before replying, with exact generation/binding checks. It is
never retried. Account proof/grant becomes unusable, while live/uncertain turn
grants stay reserved until typed terminal evidence.

The headless host persists action_required on affected tasks, wakes waiters and
keeps recoveryRequired until terminal reconciliation. A terminal error retains
that action-required text and cannot drain queued continuations. A later explicit
continuation still needs fresh authentication/admission. Tests cover both refusal
codes, unavailable, RPC refusal, exactly one safe CLI error and real-IPC task
snapshots before and after terminal. All fixtures are synthetic.

Read-only review of these two fixes reported no outstanding confirmed findings.
It found terminal reconciliation clearing the action-required text; that was
fixed and covered by the real-IPC test. The final focused round reran wrong-ID,
mixed token/refusal and lost-reply cases, verifying no duplicate fallback reply.


## Final review corrections: input/environment and compatibility

Service, provider and CLI children share a minimal environment allowlist: PATH/Path,
SystemRoot/windir/COMSPEC/PATHEXT, USERPROFILE/HOME/APPDATA/LOCALAPPDATA/TEMP/TMP,
CODEX_HOME, LANG/LC_*, NODE_EXTRA_CA_CERTS and HTTP(S)_PROXY/NO_PROXY. A fixed
ELECTRON_RUN_AS_NODE=1 is supplied internally; no inherited Node injection flags,
repository credentials or project variables cross into the service children.
Adapter space selection still uses its original cwd/CLAUDE_PROJECT_DIR.

Linked worktrees must have a gitdir/gitdir back-pointer resolving to their own
.git marker before sharing a main repository space. Missing/foreign pointers fail
closed. Submodules/separate git directories without commondir remain independent.
Task-directory reservation canonicalization retains the exact 0.3.1 algorithm;
stricter alias/device normalization is confined to service-space identity. Default
window request validation ordering and wait timer rearming also retain legacy behavior.
Malformed service waitSeconds is rejected before touching the shared connection.

S2 is an explicit owner decision: projectDirectory may execute outside the launch
space, including another repository. Tasks belong to the submitting adapter's
space; execution cwd is not an authorization boundary. This permits cross-repo
work and must be considered when enabling a service provider for MCP clients.


## User safety settings and installation lifecycle (C1/C6)

In service mode the window atomically writes only globalValue of mcpAccessMode,
mcpThreadConfig, mcpMaxParallelTasks and cliPath into serviceRoot/settings.json
on Start MCP and configuration changes. Unset values are omitted, restoring
service defaults; workspace overrides are never copied. The service validates
and rereads the file for settings queries. Changes affect subsequent task
preparation; cliPath takes effect on the next CLI connection, never by swapping
an active turn's process. Concurrent windows use last complete atomic write.

Launcher installation runs in a bounded worker, outside the Extension Host event
loop, and reuses the same complete content-addressed runtime across activations
and Start/Stop cycles. Installation is serialized; interrupted copies complete
before registration. Idle pruning holds the startup guard and retains recent
versions; published owners prevent pruning. Provider-config ACL/digest validation
also runs in a worker so PowerShell cannot block service ping/task IPC.
