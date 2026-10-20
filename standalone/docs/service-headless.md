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
UTF-8 JSON-RPC (256 KiB/frame, 32 unsettled calls each direction, 1 MiB output
queue, 5 s partial-frame/write timeout). Batch, duplicate keys, non-UTF-8 and
invalid envelopes close the connection. Requests use top-level `fence` and
`timeoutMs`, events/results/errors echo their fence; method payload is `params`.
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
  `owner` equals its binding leaseId, and `binding` and wire fence must match.
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
zero remaining confirmed findings. A subsequent narrow JSON-RPC numeric-ID
compatibility adjustment was author-checked with its own transport regression.
No real account, sign-in file, CLI or inference was used. Native macOS remains
unverified. Final validation after the local commit is recorded in the task report.

## Remaining work for 3a

Service main/headless host and integration of the provider/CLI driver with core,
space-bound IPC hello/dispatch and all task mutations,
durable intents/recovery, limit waits/poller, demand start/stable launcher,
experimental user-only setting, and the service/two-space end-to-end suite.
These requirements must be integrated before exposing service mode. Window
projections/migration belong to 3b; real Windows scenarios belong to 3c. Private
provider implementation, credential storage and rotation stay outside this repo.
