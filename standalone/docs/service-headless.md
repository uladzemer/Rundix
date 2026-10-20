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

## Remaining work for 3a

Service main/headless host, provider hook v2 config/framed RPC and grants, fenced
login/turn preparation, space-bound IPC hello/dispatch and all task mutations,
durable intents/recovery, limit waits/poller, demand start/stable launcher,
experimental user-only setting, and the service/two-space end-to-end suite.
These requirements must be integrated before exposing service mode. Window
projections/migration belong to 3b; real Windows scenarios belong to 3c. Private
provider implementation, credential storage and rotation stay outside this repo.
