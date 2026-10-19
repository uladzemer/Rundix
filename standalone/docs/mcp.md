# Claude Code → Rundix MCP

## Architecture and prerequisites

Claude launches `runtime/mcp-server.cjs` with Node.js (18 or newer). This is a stdio MCP server supporting protocol versions 2025-11-25, 2025-06-18 and 2024-11-05. It forwards bounded local requests to the running extension. It does not launch a second Codex executor.

**VS Code with Rundix must remain open.** On a remote VS Code workspace, Node and Claude must run on the same host as the workspace Extension Host. A closed VS Code cannot execute tasks. A lost MCP process does not stop tasks already accepted by the extension.

Select and configure your installed companion connection in Rundix first. The public extension contains no pool implementation; it invokes the companion through [Connection API v1](https://github.com/uladzemer/Rundix/blob/main/standalone/docs/connection-api.md). Every MCP turn uses the same `send()` path, authentication, `prepareTurn`, fresh limits, credential leases, CLI instance and sandbox policy as an ordinary chat. Server accounting remains the companion/server's responsibility. MCP fails closed with local sign-in or an unavailable selected companion. It does not export Codex credentials or change sign-in.

## Connect

1. Open and trust the project in VS Code. Select the companion connection.
2. Run **Rundix: Start MCP bridge and show Claude configuration** from the command palette.
3. The command opens an unsaved JSON document containing the exact server script and bridge descriptor paths. Copy its `mcpServers.rundix` entry into your Claude MCP configuration, or use those two paths in:

   ```powershell
   claude mcp add --transport stdio --scope user rundix -- node "<extension-directory>/runtime/mcp-server.cjs" --bridge "<extension-storage>/mcp/bridge.json"
   ```

4. Check the server with `claude mcp list` and `/mcp` in Claude Code. Restart Claude if necessary.

The CLI syntax follows [Claude Code's stdio instructions](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server). Framing follows the [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

Do not commit generated configuration containing personal paths. The descriptor contains a random bridge capability, consumed only by the local Node process; never paste its contents into a chat. The bridge listens only on `127.0.0.1`, requires this capability, rejects browser origins and bounds request sizes/timeouts. Storage uses user-only directory permissions (Windows DACL: current user and SYSTEM; POSIX: 0700 directory, 0600 records). Other processes running as the same OS user are part of the trust boundary.

Only one Extension Host per extension storage/profile owns the bridge. After opt-in, it starts again when Rundix activates (including VS Code startup). Start it in the intended trusted window. **Rundix: Stop MCP bridge** disables automatic startup; cancel active tasks and wait for confirmation first. No VS Code settings outside Rundix are changed.

## Tools

Every mutation requires a caller-generated, globally unique `requestId` (for example a UUID). On timeout, resend **identical arguments with the same ID**. Reusing an ID with different arguments fails. JSON-RPC transport IDs are not task idempotency keys.

| Tool | Arguments | Result |
| --- | --- | --- |
| `submit_task` | `requestId`, `description`, absolute `projectDirectory`, `acceptanceCriteria`; optional `model`, `effort` | A persisted `taskId` and initial snapshot, before model execution |
| `get_task` | `taskId` | State, progress, `chatId`, canonical directory, timestamps, pending requests, report, recovery flag |
| `continue_task` | `requestId`, `taskId`, `clarification` (queued during an active turn); or `approval` for a pending request | Same task and same chat; a queued/new turn or approval response |
| `cancel_task` | `requestId`, `taskId` | Cancellation requested; poll until confirmed |
| `list_tasks` | optional `limit` (1–100, default 25) | Most recently updated snapshots |

States: `queued`, `running`, `waiting_approval`, `completed`, `error`, `cancelled`. Progress is descriptive, not an invented percentage. While the companion waits for quota reset, progress identifies the wait and cancellation remains available. Tasks execute serially within the bridge. Per-directory leases also prevent simultaneous turns from ordinary Rundix chats and other windows using the same storage. Real paths resolve symlink aliases; Windows paths compare case insensitively. Separate worktrees are separate directories. This does not lock unrelated applications such as Claude's own shell: do not let them edit the same project concurrently.

`pendingRequests` includes the original method, ID and requested operation. Obtain the user's decision in Claude before calling `continue_task` with `approval`. Example:

```json
{"requestId":"synthetic-approval-1","taskId":"<taskId>","approval":{"id":"<pending-id>","decision":"accept"}}
```

Use `decline` or `cancel` to refuse. Blocking questions use `approval.answers` mapping question IDs to strings, or `skip:true`. Form elicitation uses `decision` and `content`. The extension's existing answer handler validates forms, available decisions and permissions. Session-wide approval is not exposed by this MCP. Approvals may also be answered in the Rundix chat. MCP never accepts them automatically.

## Scenario

1. Submit `{"requestId":"synthetic-submit-1","description":"Create a greeting function","projectDirectory":"<absolute-project-directory>","acceptanceCriteria":"The function has a passing unit test"}`.
2. Poll `get_task` using the returned `taskId`. Rundix creates a visible chat and sends through the selected companion. Resolve pending requests explicitly.
3. On `completed`, inspect `report`: `result`, `changedFiles`, `checks`, `remainingIssues`. `source:model_report` identifies model-reported data; `source:transcript_evidence` identifies a fallback built from observed file-change and command items. A successful turn is not a guarantee that all acceptance criteria passed: inspect the checks and remaining issues.
4. Call `continue_task` with a new `requestId` and `clarification:"Add a second greeting test"`. Poll again and verify `chatId` remains unchanged.

Task bindings, inputs, idempotency records and reports are persisted locally, never logged. Up to 1000 tasks and 1000 mutation records per task are retained; submissions fail rather than evicting deduplication keys. Archive storage only while the bridge is stopped, after resolving outstanding work.

After Extension Host restart the bridge observes saved chats and active turns; it never repeats the original input. If a send or connection result is ambiguous, the task becomes `error` with `recoveryRequired:true`, and its directory remains reserved. Restore the selected connection, inspect the chat, then explicitly continue. The previous turn must be observed inactive before a continuation can start. Changing the selected connection revision blocks old tasks to avoid crossing account/connection contexts; do not switch providers with unfinished MCP work. A permanently unavailable companion or damaged chat requires manual recovery; do not delete reservations until you have verified that no turn is active.

## Local validation

`npm.cmd test` covers synthetic persistence, replay, queue, cancellation, directory exclusion, channel authentication and stdio RPC. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/host.ps1 -TestFile mcp-host.cjs` exercises the real Extension Host with synthetic CLI and companion: submit → chat → companion preparation → report → same-chat continuation, approvals and cancellation. It performs no real sign-in or model inference. A real pool/model end-to-end run additionally needs the separately installed companion and its test environment.
