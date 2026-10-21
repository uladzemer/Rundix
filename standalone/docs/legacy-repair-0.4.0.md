# Legacy import repair in 0.4.0

## Reproduction and cause

Owner-authorized investigation used a newly allocated temporary directory outside
this repository. Only task files and session records were copied; no leases,
authentication files or credentials were imported. No source records were edited.
Output was restricted to structural counts, field names and status codes.

The unchanged migration reproduced `needs_repair / migration_conflict` with 52
parseable completed tasks. All referenced sessions existed and their keys/chat IDs
matched. The exact failing predicate was `session.mcpTask !== true`: 12 referenced
sessions omitted that field and 10 persisted `false`. Modifying only this field on
the temporary copy made the old importer return `ready`. A fresh unmodified copy
with the fixed importer returned `ready` and imported all 52 tasks. The service's
bridge lease was therefore not the cause of this repair error; migration keeps its
own acquired lease and does not reacquire it on retries.

Task key/chat references now identify legacy transcripts without requiring the
0.3.x boolean flag. Missing or unrelated session records leave a read-only task
summary; unrelated chat content is excluded. Vanished project directories keep
legacy entries in the existing workspace-scoped legacy space. No imported task
enters execution. Corrupt task files, unsafe identifiers, oversized source files,
and broken committed migration hashes still fail closed rather than silently
claiming a successful import. The source backup and committed history checks
remain enforced.

The chat MCP button previously consumed only the window bridge state, which is
always absent in service mode. It now consumes the current service peer state;
connect/disconnect/stop broadcasts refresh existing chat buttons. Migration
status is independent of service connectivity.

## Acceptance-profile registry cleanup

Run from the repository root after closing the old acceptance-test windows.
Preview (only counts are printed):

```powershell
node standalone/scripts/cleanup-live-legacy-roots.cjs
```

Remove exactly the three old acceptance-profile registry entries:

```powershell
node standalone/scripts/cleanup-live-legacy-roots.cjs --apply
```

The command selects only direct `rundix-live-*`, `rundix-n7-*`, `rundix-n8-*`
children of the canonical OS temporary directory with the exact suffix
`vscode-profile/User/globalStorage/local-rundix-tools.rundix`. It refuses unless
there are exactly three candidates. Under the same `legacy-roots` lease used by
the service, it saves the original registry bytes to a unique adjacent `.bak`
file and atomically rewrites the registry. It does not delete profiles, tasks,
receipts, imported history or the owner's real legacy entry. If the registry is
busy, retry after the current short registration finishes. Preview also acquires
and releases that lease. The command was tested only on synthetic registries;
it was not applied to the owner's registry during this repair.

Automatic pruning removes only roots for which filesystem lookup returns
`ENOENT`; permission failures retain registration. Pruning occurs at registration
(before the capacity check) and during synchronization. Registry contention skips
that pruning pass rather than reporting data corruption.

## Harness rules

`test/host.ps1` prepares a source-only development extension and establishes test
isolation before activation. Source harnesses reject the actual production
service directory even if an explicit root is passed. `live.cjs` and
`modes-live.cjs` now enter the same isolation helper before loading runtime code.
Production runtime behavior does not read test environment overrides.

The earlier N5/N7/N8 installed-extension acceptance runs intentionally used the
real service and left the three temporary registrations behind. Do not repeat
that harness pattern: installed extension activation always registers its legacy
storage. Run installed-extension acceptance against a separately installed
synthetic service root, or use a direct window client without `legacyRoot` for
an explicitly authorized shared-service read-only check. Never activate a test
profile against the production service. Do not infer isolation merely from
`--user-data-dir`: service storage is independent of the VS Code profile.

## Validation scope

Regression fixtures are entirely synthetic and cover absent/false flags,
missing/unrelated transcripts, deleted worktrees, restart persistence, vanished
registry entries, registry lock contention, and cleanup count/backup/path-alias
rules. Extension Host checks assert the emitted chat icon state on service
start/stop while the window executor remains absent. Browser checks cover both
languages, themes and widths. No owner sign-in or settings were changed, and no
repaired package was installed over the owner's edition.

Completed local checks: `npm.cmd test` (55 suites), isolated Extension Host
`service-mode-host.cjs` and `mcp-host.cjs`, `npm.cmd run test:browser`,
`npm.cmd run package`, and `git diff --check`. All passed. The actual VSIX ZIP
was audited (139 entries); package identity/version, changed host/migration
source, README and three branding assets matched the worktree. Test harnesses,
maintenance scripts and reproduction copies are excluded from that package.
Browser screenshots were inspected in Russian/dark/narrow and
English/light/wide; automated browser coverage includes all combinations.

A fresh-context read-only reviewer performed three rounds under `REVIEW.md`.
Findings about pruning contention, inaccessible roots, synthetic path defaults,
and the Windows Temp alias were fixed. The final Temp canonicalization fix was
verified by the author with the synthetic junction regression and full suite;
it did not receive a fourth independent review. Validation is static,
synthetic runtime/Extension Host/browser, plus migration on an owner-authorized
copy; no live model request or production installation was performed.

An attempted deletion of the allocated reproduction-copy directory was rejected
by automatic approval review (`blocked by policy`). Copies remain outside the
repository; they are not staged or packaged. Production registry cleanup was
never executed.
