# Headless IPC foundation (stage 1, not installed)

These CommonJS modules use Node built-ins and do not import VS Code. No extension
commands, launcher, executor, account, task, or provider behavior is wired yet.
The `.vscodeignore` allowlist is unchanged; the ZIP audit asserts that these four
modules are absent. This document and synthetic tests are also excluded.

## API

- `service-endpoint.locations({root?})` computes discovery and the fixed listener.
  Always supply a unique temporary `root` in tests: it isolates discovery **and**
  the pipe/socket name. The root is hashed in Windows pipe names, never embedded.
- `startService({root?, entryPath?, serviceVersion?, call?})` returns either
  `{status:'already_running', connect(options)}` or an owner exposing `ready()`,
  `dispose()`, `clients()`, `busy()`, `broadcast(method, params)`, and `generation`.
  `clients()` includes connections awaiting authentication; `busy()` counts
  unsettled application RPC work, including work whose connection has closed.
  Only the owner publishes discovery. `starting` is published before returning;
  the future service entry calls `ready()` after its own recovery gates.
- `connectService({root?, startupTimeoutMs?, pingTimeoutMs?})` rereads discovery
  and retries ping/hello during the bounded startup window (20 s default,
  100–1000 ms backoff). It returns an authenticated peer with
  `call(method, params, timeoutMs)`, `on('event', ...)`, `on('closed', ...)`,
  and `close()`. Calls automatically carry generation. Mutations are never retried.
  Discovery FS failures have a separate bounded retry budget (`discoveryRetryMs`,
  2 s default, capped by the remaining startup deadline); exhaustion reports
  `discovery_unavailable`, distinct from `service_start_timeout`. `probeOwner`
  and `recoverHung` apply the same bounded discovery-read retry policy.
- `probeOwner(options)` returns absent/responding/hung/dead/unverified/unknown.
  Failed ping precedes PID and OS process-start verification.
- `recoverHung({...options, verifyEntry, stopVerified})` is an **explicit** hook.
  It requires two failed pings, matching PID/start time and a successful trusted
  entry check. It rechecks discovery and identity before `stopVerified`, waits
  for confirmed death, then clears stale endpoint/discovery under the startup
  lease. No automatic killing, spawning, or restart is implemented.
  The future installed launcher must implement `verifyEntry(descriptor)` against
  the OS process's installed entry, and `stopVerified(identity)` with a final OS
  identity check and verified shutdown of registered children. Callback success
  alone cannot authorize a new turn; child recovery gates belong to integration.
- `service-ipc` exposes low-level `Peer`, `accept`, `dial`, `authenticate`,
  `proof`, size constants, and safe coded errors. A peer emits events only after
  hello. Server `call(method, params, peer, context)` must scope async side effects to its
  own session, honor per-call `context.signal` and connection `peer.signal`,
  and check ownership after awaits. Handler timeout aborts only that call, sends
  `rpc_timeout`, suppresses late delivery and retains its in-flight slot until
  work settles. Other calls and events on the connection remain usable. The service caps unsettled application work across all
  connections at 64. Timeout/close cancels delivery, not arbitrary application
  work; include `service.busy()` in the idle hook's busy callback.
  Domain RPC dispatch must validate binding/space,
  roles and capabilities; this foundation only validates auth and generation.
- `service-process.processIdentity(pid)` obtains OS creation identity without
  command lines or credential files; `ownerState(descriptor, inspect?)` compares
  both PID and start identity. A different start time proves the descriptor owner
  is gone; an unknown identity does not. `processIdentityAsync(pid)` is used by
  endpoint/recovery to avoid blocking IPC timers. Self start identity is cached;
  remote identities are queried afresh.
- `service-lifecycle.idleExit({clients, busy, onIdle, idleMs?, pollMs?})` returns a
  disposable idle hook. A successful `onIdle` completes the hook; `false` or
  `{exiting:false}` declines and rearms, as does rejection. An injected `log`
  receives sanitized error codes. `now`, `schedule`, and `cancel` allow
  deterministic clock tests. Integrators must report queued/running work, waits,
  approvals, uncertain turns and children as busy. No process exit is performed.

## Choices relative to headless-protocol.md D11–D16

Windows uses the specified SID from bounded PowerShell WindowsIdentity, SHA-256
truncated to 24 hex characters. The validated SID is cached per process.
PowerShell SID/process queries use a 10 s cap, matching mcp-bridge; remote process
queries are asynchronous and are not cached across ownership checks. No user name or personal path occurs in the fixed
pipe name. Pure Node here means no native addons; bounded OS tools are used for
SID, ACL and process creation identity as permitted by the design.

macOS/Linux use `/tmp/rundix-<uid>/service-v1.sock`, private and owner-checked.
macOS discovery uses `~/Library/Application Support/Rundix/service`; Linux uses
`~/.local/state/Rundix/service` (Linux discovery location was unspecified).
Directory symlinks and wrong POSIX owners are rejected; modes are 0700/0600.
Windows follows `mcp-bridge`'s SID+SYSTEM `icacls` inheritance removal. Native pipe
DACL, peer UID and hostile same-user protection remain deferred per H01.

The existing `SessionStore.acquire('service-startup')` guards listen/publication
and shutdown as well as POSIX stale socket cleanup. It does not replace listen
as the singleton authority. `EADDRINUSE` returns already_running; no loser writes
discovery. Socket removal requires either a missing descriptor or a proven dead
owner (including PID reuse), plus an OS connect probe returning ECONNREFUSED
under the startup lease. A live/unknown owner or listening/unverifiable endpoint
prevents unlink. Slow recovery ping/entry probes and death polling run outside
the lease; generation and identity are rechecked before stop and cleanup.
Discovery is a bounded version-2 record written through unique temp+rename.
EPERM/EBUSY/EACCES are retried during startup discovery reads and publication;
symlink, owner and mode validation failures remain hard security errors.

NDJSON JSON-RPC 2.0 follows D15: one object per line, no batch, maximum 1 MiB in
UTF-8 per line, incremental parsing and 5 s incomplete-frame timeout. Malformed
transport frames close the peer; domain JSON-RPC parse/method error mapping is
left to the later dispatcher. Generic RPC error envelopes use safe symbolic
codes without exposing original exception text. Write queue >2 MiB disconnects;
write stalls have a 5 s deadline. Maximum 64 connections, 64 pending outgoing
and 64 in-flight incoming calls per peer bound unauthenticated and slow clients.
Default request/handler deadline is 12 s; explicit outgoing budgets are bounded
to 1515 s. Dispatcher option `ipc.getHandlerTimeoutMs(method, params, peer)`
selects a per-call handler budget (maximum 1515 s), with `undefined` falling back
to `handlerTimeoutMs` or the 12 s default. The dispatcher must validate long-poll
arguments and choose the matching client budget; raw wire values do not change
the deadline unless the dispatcher authorizes them.

Ping works before hello and reports status/generation plus a random 32-byte
connection-bound nonce. The one-use nonce expires after 5 s; proof uses
HMAC-SHA256 with the exact D15 prefix and generation. The 64-hex discovery secret
is used as the HMAC key string; it is never sent. Comparison is constant-time.
Unauthenticated connections expire after 5 s; repeated hello cannot reuse a nonce.
Auth failures trigger discovery reread and fresh connection/ping/hello, with no
spawn/kill. The secret stays in private discovery and memory, never diagnostics.

D14 launcher spawn, installed-entry verification and child recovery, D15 full
binding/capability negotiation, D16 periodic heartbeat/reconnect and application
dispatch remain explicit integration responsibilities. The foundation provides
the hooks rather than pretending the future service is already installed.

## Validation

`node test/service-ipc.cjs` (included in `npm test`) uses temporary roots only:
real two-process singleton race and loser connection, stale discovery replacement,
request/event flow, pre-auth denial, wrong secret and nonce replay, startup secret
race and starting/ready transition, byte limits and combined frames, partial-frame
and RPC deadlines, backpressure, ping timeout with PID reuse/unknown identity,
explicit recovery refusal/success, and idle exit with clients/busy work, rejection
logging and decline/retry under an injected clock.
Regression cases cover a shared ping/hello startup deadline, isolated handler
timeout/work accounting, mixed handler budgets, retryable shutdown after lease
contention, actual stale socket unlink through injected fs/probe, and transient
discovery read/rename failures with hard security rejection (14 groups).
Shutdown regression also checks that a client can still connect after guard
contention, and that descriptor read/unlink after close retries transient errors.
Windows pipe/ACL/process identity are exercised on Windows. POSIX behaviour is
covered only through injected fs/probe mocks and naming/permission logic tests
on Windows. These do not establish native POSIX behaviour: a native POSIX smoke
run, including Unix socket cleanup and process identity, is still required.

Validation commands: `npm.cmd test`, three separate runs of
`node test/service-ipc.cjs`, and `npm.cmd run package` with its actual-ZIP audit.
Delete the generated VSIX after auditing. No live sign-in or CLI account is used.
