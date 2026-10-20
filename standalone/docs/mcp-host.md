# MCP host extraction (checklist item 2)

`createMcpHost(options)` in `runtime/mcp-host.cjs` owns the current window's
MCP scheduler. The extension uses this same factory. This is extraction only;
it does not start or connect the background service.

API:

- Required: `core` (the session core), `storageRoot` (existing global storage),
  `trusted()` (fails closed by default in the factory).
- `settings(key)` returns **user-only** MCP settings; `version` labels the stable
  launcher copy. `clock.setTimeout/clearTimeout` defaults to Node timers.
- Plain UI callbacks: `openChat(saved)` returns the opened session; `hasChat`,
  `closeTab`, `closeSavedTab`, `sent`, `reloadWindow`, `enabled`, `changed`.
  Without `openChat`, sessions are created through the core without UI handles.
  Without `reloadWindow`, `reload_window` fails with `unsupported`.
- `transport` defaults to `mcp-bridge.cjs`; Node tests inject a fake bridge.
- Returns `start()`, `stop()`, `dispose()` and live getters `tasks`, `bridge`,
  `launcher`. `stop()` retains the previous active-task guard; `dispose()` is
  the synchronous extension teardown path.
- MCP stop/answer/answerAsync dismiss the previous session error before dispatch,
  matching the editor handler's existing behavior.
- `spaceOf(task)` defaults to `task.space`; `taskFilter(space, task)` defaults to
  true. Task records may carry optional `space`; production creates legacy
  records without it. `list_tasks`, `get_task`, `wait_task`, `wait_tasks` share
  this hook. It is a preparation seam, **not space isolation**.

Moved code:

| From extension.cjs | Destination |
| --- | --- |
| McpTasks/executor construction, start/stop/cleanup | runtime/mcp-host.cjs |
| Catalog loading timeout, model projection, reload guard/timer | runtime/mcp-host.cjs |
| Recovered-turn retention and connection/client adapters | runtime/mcp-host.cjs |
| Stop and blocking-answer protocol actions | runtime/session-actions.cjs, exposed by session core |
| Panel/tab operations and user settings | Remain in extension.cjs |

Unchanged storage and coordination:

- Sessions and directory reservations: `<storageRoot>/sessions-v1` via core.store.
- Tasks: `<storageRoot>/mcp/tasks/mcp-task-<id>.json`.
- Root lease: core.store.acquire('mcp-bridge'), before launcher installation.
- Descriptor: `<storageRoot>/mcp/bridge.json`; stable launcher:
  `<storageRoot>/mcp/bin/mcp-server.cjs`; packaged runtime fallback unchanged.
- Directory reservation/retention uses runtime/task-directory.cjs unchanged,
  including its existing canonicalization/key algorithm.

Remaining service wiring: transfer factory ownership to the service process;
connect service-owned session core/provider and UI event callbacks; implement
space routing and space-scoped operation deduplication/replay/recovery under
headless-protocol.md. No migration, new paths, IPC wiring or provider lifecycle
protocol is introduced here.

Validation: Node-only test `test/mcp-host-node.cjs` uses the real session core,
McpTasks and executor with fake CLI/bridge transports, forbidding vscode loads.
It covers submit/run/report/close, trust, legacy paths/lease, cleanup, restart,
optional filtering and the extracted blocking-answer path. It runs in npm test.
