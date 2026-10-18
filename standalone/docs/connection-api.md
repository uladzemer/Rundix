# Connection API v1 — Rundix 0.2.0

Rundix uses local CLI sign-in by default. An installed companion extension may register an additional connection provider through the object returned by `vscode.extensions.getExtension('local-rundix-tools.rundix').activate()`. A companion declares that extension ID in `extensionDependencies` and checks `api.connections.version === 1` before registration.

This is an API for trusted installed extensions in the extension host, not a sandbox for web content. The public package does not include any companion's authentication service implementation, device keys, account pool or rotation code. Registration alone never changes the selected connection.

## Registration and configuration

`api.connections.registerProvider(ownerExtensionId, provider)` returns a disposable. Provider IDs must be unique. The owner extension ID is retained with an explicitly selected provider so Rundix can activate the same owner after a restart. A missing or incompatible selected provider causes an error; Rundix never silently sends through local sign-in instead.

The provider supplies:

- `id`, `label`: stable identifier and display label.
- `accountLabel` (optional): a generic account label, at most 100 characters. External connections expose no account email or plan to the webview by default.
- `authenticate(client)`: establish or renew authorization through a scoped CLI facade. The facade exposes only `request` and `respond`, and checks the connection revision and server owner before and after requests.
- `configure()`: show the companion's settings. Return `activate`, `local` or `cancel`. Runs under Rundix's idle credential lease; running tasks prevent connection mutation.
- `requestMethods` and `handleRequest(client, request)` (optional): explicitly declared CLI requests handled by the companion. Methods are bounded in number/length; the owner must bound network waits and handle failures.
- `prepareTurn({limits, assertCanChange, reconnect, readLimits})` (optional): inspect fresh limits before a task. Call `assertCanChange()` before any account-selection mutation. `reconnect()` checks idle turns, saves session state, replaces the CLI and reloads account/catalog state. Never repeat a model turn after an ambiguous response.
- `waitForReset(until, isAlive)` (required if preparation returns `{waitUntil}`): cancellable waiting after the send credential lease is released. Stop when `isAlive()` returns false. Returns whether to retry preparation; the actual task is never replayed after an ambiguous send result.

`api.connections.configure(providerId)` opens/configures a registered provider. `api.connections.useLocal()` explicitly selects local CLI sign-in. The account menu exposes generic connection settings whenever an additional provider is registered or selected.

## Legacy conversation metadata

`api.connections.importHistory(ownerExtensionId, {sessions, metadata})` accepts a bounded snapshot from a registered owner. It copies session records, drafts, queued tasks and metadata into Rundix's store under an idle lease. Existing keys, duplicate thread IDs and damaged targets are preserved, not overwritten. The result includes imported/unchanged/conflict counts. It does not read the source extension's files or credentials and does not import every VS Code setting or native tab arrangement.

The companion owns reading its own legacy metadata safely, checking old active leases and leaving the source intact. It must not include credentials or authentication files in the snapshot. The owner remains responsible for checking conflicts before retiring its old installation.

## Validation

Synthetic registry/history tests cover registration without switching, unavailable/stale owners, privacy projection, unreadable selection recovery, repeat imports and preserved newer/damaged targets. Ordinary local CLI/browser/startup checks remain required. Companion integration should test two extensions together in an isolated profile with a synthetic transport and synthetic service; do not switch a user's real sign-in for test convenience.
