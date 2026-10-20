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

This login gate is necessary but **not sufficient** for dispatch: provider-v2
per-turn admission, lease lifecycle, idle-only account mutation, refresh routing,
durable intent/reconciliation and persisted child recovery remain to be wired.
The facade deliberately rejects positive CLI replies before confirmed login;
v2 `handleRequest`/refresh integration is still outstanding.

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

## Remaining work for 3a

Service main/headless host, provider hook v2 config/framed RPC and grants,
integration of the CLI gate with provider login/turn preparation,
space-bound IPC hello/dispatch and all task mutations,
durable intents/recovery, limit waits/poller, demand start/stable launcher,
experimental user-only setting, and the service/two-space end-to-end suite.
These requirements must be integrated before exposing service mode. Window
projections/migration belong to 3b; real Windows scenarios belong to 3c. Private
provider implementation, credential storage and rotation stay outside this repo.
