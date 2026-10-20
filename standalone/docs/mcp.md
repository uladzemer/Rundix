# Claude Code → Rundix MCP

## Architecture and prerequisites

Claude launches a stable copy of `runtime/mcp-server.cjs` with Node.js (18 or newer). When the bridge starts, Rundix copies the server into `<extension-storage>/mcp/bin/`, so Claude's configuration keeps working after Rundix updates; configurations created by version 0.2.2 or older point into the versioned extension folder and must be copied again once. This is a stdio MCP server supporting protocol versions 2025-11-25, 2025-06-18 and 2024-11-05. It forwards bounded local requests to the running extension. It does not launch a second Codex executor.

**VS Code with Rundix must remain open.** On a remote VS Code workspace, Node and Claude must run on the same host as the workspace Extension Host. A closed VS Code cannot execute tasks. A lost MCP process does not stop tasks already accepted by the extension.

Select and configure your installed companion connection in Rundix first. The public extension contains no pool implementation; it invokes the companion through [Connection API v1](https://github.com/uladzemer/Rundix/blob/main/standalone/docs/connection-api.md). Every MCP turn uses the same `send()` path, authentication, `prepareTurn`, fresh limits, credential leases, CLI instance and sandbox policy as an ordinary chat. Server accounting remains the companion/server's responsibility. MCP fails closed with local sign-in or an unavailable selected companion. It does not export Codex credentials or change sign-in.

## Connect

1. Open and trust the project in VS Code. Click the visible **MCP** button at the top of any Rundix chat. It opens the **Rundix · MCP** editor tab; no command palette is needed. The sidebar **Rundix → MCP tasks** remains available too.
2. In the MCP tab click **Connect pool**, then **Start MCP** and **Claude configuration**.
3. The configuration appears directly in that tab. Click **Copy configuration** to copy the `mcpServers` JSON into your Claude MCP configuration. If `rundix` is already registered in Claude Code, copying it again is unnecessary. For CLI setup, the same server script and bridge descriptor paths can be used in:

   ```powershell
   claude mcp add --transport stdio --scope user rundix -- node "<extension-storage>/mcp/bin/mcp-server.cjs" --bridge "<extension-storage>/mcp/bridge.json"
   ```

4. Check the server with `claude mcp list` and `/mcp` in Claude Code. Restart Claude if necessary.

The CLI syntax follows [Claude Code's stdio instructions](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server). Framing follows the [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

Do not commit generated configuration containing personal paths. The descriptor contains a random bridge capability, consumed only by the local Node process; never paste its contents into a chat. The bridge listens only on `127.0.0.1`, requires this capability, rejects browser origins and bounds request sizes/timeouts. Storage uses user-only directory permissions (Windows DACL: current user and SYSTEM; POSIX: 0700 directory, 0600 records). Other processes running as the same OS user are part of the trust boundary.

Only one Extension Host per extension storage/profile owns the bridge. After opt-in, it starts again when Rundix activates (including VS Code startup). Start it in the intended trusted window. **Rundix: Stop MCP bridge** disables automatic startup; cancel active tasks and wait for confirmation first. No VS Code settings outside Rundix are changed.

The **MCP** button in the chat shows a green dot while this Extension Host's bridge is running. Opening it preserves the current chat draft and does not switch the connection or start the bridge. The editor tab and sidebar share the same task service. Existing command-palette commands remain available for compatibility, but the normal controls and configuration copy are all in the UI.

## Working pool and task panel

**Connect pool** uses the existing selected companion. When local sign-in is selected, this explicit action activates installed extensions declaring a dependency on Rundix. It configures the sole registered companion, or asks you to choose when several are available. Registration and merely opening the panel never switch connections. If the companion needs interactive setup, complete its own prompt. No separate MCP pool or token import is created.

The connection indicator is based on the existing CLI account/limit reads through the selected provider; it does not claim that a model request has passed. Every actual task still calls the companion's normal authorization and server limit preparation. Missing companions and local sign-in remain blocked for MCP submissions.

The panel displays up to 100 recent tasks, state, directory and report. **Open chat** opens the original Codex chat. **Send continuation** queues a follow-up in that chat; **Cancel task** uses the same task service as Claude's MCP call. Permission requests are reviewed in the chat or Claude, never automatically approved by the panel. Drafts survive background refresh, failed submission and text typed while a prior submission is pending. Recent tasks remain visible with the bridge stopped.

## Access mode and chat titles

Each task opens a visible Rundix chat titled `MCP · ` plus up to 160 characters of the task description (whitespace collapsed, ellipsis when truncated). VS Code shows the same title on the tab and in its hover, so to keep tabs narrow while the hover shows what the task is about, set `"workbench.editor.tabSizing": "fixed"` (optionally with `workbench.editor.tabSizingFixedMaxWidth`). Its access mode comes from the user setting **Rundix: Mcp Access Mode** (`rundix.mcpAccessMode`): `workspace` (default, asks for extended actions), `manual`, `auto` (Codex automatic review) or `full`. With `full`, Codex may change files and use the network outside the project without approval requests, so `pendingRequests` normally stays empty. The mode is applied once, when the task's chat is created; continuations keep whatever mode the chat has, including changes you make in the chat. The value is read only from your user settings: workspace settings of a repository cannot grant MCP access. Plan mode is not offered because MCP tasks run unattended.

`rundix.mcpThreadConfig` (user settings only) is sent as the per-thread Codex `config` of MCP task chats on `thread/start` and `thread/resume`; ordinary chats are unaffected. Codex starts the MCP servers and plugins from `~/.codex/config.toml` for every thread with the thread's folder as their working directory, and some of them (for example the computer-use `node_repl` server and the browser/computer-use plugins) keep running after the task, so on Windows the task's worktree cannot be removed until VS Code reloads. Disabling the ones unattended tasks do not need avoids that, for example:

```json
"rundix.mcpThreadConfig": {"mcp_servers": {"node_repl": {"enabled": false}}, "plugins": {"browser@openai-bundled": {"enabled": false}, "computer-use@openai-bundled": {"enabled": false}}}
```

## Tools

Only `submit_task`, `continue_task` and `cancel_task` require a caller-generated, globally unique `requestId` (for example a UUID). On timeout, resend **identical arguments with the same ID**. Reusing an ID with different arguments fails. Other tools, including `close_task`, `reload_window`, `list_models` and waits, take no `requestId`. JSON-RPC transport IDs are not task idempotency keys.

| Tool | Arguments | Result |
| --- | --- | --- |
| `submit_task` | `requestId`, `description`, absolute `projectDirectory`, `acceptanceCriteria`; optional `model`, `effort` | A persisted `taskId` and initial snapshot, before model execution |
| `get_task` | `taskId`; optional `brief` (boolean, default false) | State, progress, `chatId`, canonical directory, timestamps, `revision`, `accessMode` the task chat was created with (later changes made in the chat are not reflected), pending requests, report (or compact `reportSummary` with `brief:true`), recovery flag |
| `wait_task` | `taskId`; optional `waitSeconds` (1–1500, default 600), `afterRevision`, `brief` (boolean, default false) | Blocks until the task is settled (`completed`, `error`, `cancelled`, `waiting_approval`) or the time elapses; the `get_task` snapshot plus `timedOut` |
| `wait_tasks` | `taskIds` (1–50); optional `waitSeconds`, `brief` | Blocks until any listed task is settled; `{settled, waiting, timedOut}` |
| `continue_task` | `requestId`, `taskId`, `clarification` (queued during an active turn); or `approval` for a pending request | Same task and same chat; a queued/new turn or approval response |
| `cancel_task` | `requestId`, `taskId` | Cancellation requested; wait until confirmed |
| `list_tasks` | optional `limit` (1–100, default 25), `state`, `projectDirectory`, `cursor` | `{tasks, nextCursor}`: compact summaries without reports, newest created first |
| `close_task` | `taskId` of a finished task | Closes its editor tab (`chatClosed`); the chat is kept and a continuation reopens it |
| `list_models` | none | Models of the selected connection with supported efforts and defaults, for choosing `model`/`effort` |
| `reload_window` | optional `force` | Reloads the VS Code window running Rundix (for example after installing a build); refused while chats or MCP tasks run unless `force:true` |

`revision` increases whenever the stored task changes. `wait_task` returns immediately for a settled task; pass `afterRevision` from an earlier snapshot to wait for a newer settled state. A queued task blocked by a busy directory or connection stays `queued` with the reason in `progress`, so `wait_task` returns `timedOut:true` until it can run; tasks for other directories keep running.

With `brief:true`, `get_task` and `wait_task` replace `report` with `reportSummary`: `{source, resultPreview, resultLength, changedFiles, checksCount, remainingIssuesCount}`, or `null` when no report exists. The preview contains the first 500 characters of `report.result`, followed by `…` only when truncated; `resultLength` is the full result length. All changed files and complete `pendingRequests` remain available. Omit `brief` or pass `false` to retrieve the full report.

The HTTP bridge limits each request and response to **1 MiB of UTF-8 bytes**, including its JSON envelope. A combined `wait_tasks` response with many full reports can exceed this limit: `response_too_large` tells the client to retry with `brief:true`, or fewer `taskIds` if the compact response is still too large. Full reports remain available individually through `get_task` within the same limit.

Errors are returned as `<code>: <message>` with an actionable message, for example `bridge_unavailable` (start the bridge in VS Code, then retry with the same `requestId` where applicable), `unknown_task`, `invalid_argument`, `invalid_directory`, `request_conflict`, `connection_unavailable`, `approval_not_pending`, `approval_rejected`, `delivery_unknown`, `response_too_large`, `workspace_untrusted`, `limit`. Unexpected failures are reported as `rejected: <safe message>`.

`reload_window` reloads the VS Code window hosting the bridge; it takes only optional `force:true`. Without force, active MCP tasks and ordinary chats block it with `task_active`. A reload briefly disconnects the bridge; the background waiter retries through this interruption. Forced reloads may leave turns requiring reconciliation, so inspect their status afterwards.

### Waiting in the background

To keep working while Codex runs, start the launcher as a background shell command; it exits when the task needs attention:

```powershell
node "<extension-storage>/mcp/bin/mcp-server.cjs" --bridge "<extension-storage>/mcp/bridge.json" --wait <taskId> --timeout 3600
```

Pass several comma-separated IDs (`--wait <id1>,<id2>`) to supervise parallel tasks: the waiter uses `wait_tasks`, prints `{settled, waiting, timedOut}` as soon as any of them needs attention, and exits `2` if one waits for approval, otherwise `3` if one failed, otherwise `0`.

It prints the final snapshot as one JSON line. Add `--brief` to pass `brief:true` to `wait_task` or `wait_tasks` and print compact report summaries. On `response_too_large`, the launcher automatically retries once in brief mode; if that is still too large it reports the error. Exit codes: `0` completed, `2` waiting for approval, `3` error or cancelled, `4` timed out, `1` rejected request. While the bridge is briefly unavailable (for example during a VS Code window reload) it retries every five seconds until the timeout. In Claude Code, run it with background execution so the session is notified when it exits.

States: `queued`, `running`, `waiting_approval`, `completed`, `error`, `cancelled`. Progress is descriptive, not an invented percentage. While the companion waits for quota reset, progress identifies the wait and cancellation remains available. Up to `rundix.mcpMaxParallelTasks` tasks (default 3, at most 5) run Codex turns at the same time; tasks for the same project or git worktree always run one after another, so give parallel work separate worktrees. Per-directory leases also prevent simultaneous turns from ordinary Rundix chats and other windows using the same storage. Real paths resolve symlink aliases; Windows paths compare case insensitively. A lease covers the whole enclosing git worktree, so a chat in a subfolder and a task in the repository root exclude each other; a separate git worktree (its own `.git` file) is independent, even when it is nested inside the repository. Outside git, only the exact directory is leased, so avoid running work in a folder and its subfolder at the same time. A task whose directory was deleted while running needs manual recovery; its lease is released once it is resolved. This does not lock unrelated applications such as Claude's own shell: do not let them edit the same project concurrently.

`pendingRequests` includes the original method, ID and requested operation. Obtain the user's decision in Claude before calling `continue_task` with `approval`. Example:

```json
{"requestId":"synthetic-approval-1","taskId":"<taskId>","approval":{"id":"<pending-id>","decision":"accept"}}
```

MCP task turns tell Codex that the requester is an automated agent client: Codex decides routine details itself and, when it really needs a decision, asks with a blocking `item/tool/requestUserInput` request. If it still posts an asynchronous quiz in the chat, the task stays `waiting_approval` and the quiz appears in `pendingRequests` as method `rundix/asyncQuestion` with ID `async-question:<itemId>` and `params.questions` (`id`, `title`, `options`). Answer it like a blocking question, with `approval.answers` keyed by question `id`, or `skip:true`; the reply reaches Codex in the same chat and the task continues.

If the reply RPC may have been accepted but its response is lost, the operation is recorded as `unknown` and the task enters `error` with `recoveryRequired:true`. `delivery_unknown` blocks answering again, including with a new `requestId`. The bridge never resends that answer automatically. Recovery reads the transcript and turn state: an observed reply confirms delivery; an inactive turn with a complete transcript and no reply permits a new explicit answer. While the turn may still be live or the transcript is incomplete, the question remains blocked. A confirmed cancellation removes unanswered asynchronous questions from that run's `pendingRequests`, allowing thread release and `close_task` without starting another turn.

Use `decline` or `cancel` to refuse. Blocking questions use `approval.answers` mapping question IDs to strings, or `skip:true`. Form elicitation uses `decision` and `content`. The extension's existing answer handler validates forms, available decisions and permissions. Session-wide approval is not exposed by this MCP. Approvals may also be answered in the Rundix chat. MCP never accepts them automatically.

## Scenario

1. Submit `{"requestId":"synthetic-submit-1","description":"Create a greeting function","projectDirectory":"<absolute-project-directory>","acceptanceCriteria":"The function has a passing unit test"}`.
2. Call `wait_task` with the returned `taskId` (or start the background waiter). Rundix creates a visible chat and sends through the selected companion. Resolve pending requests explicitly.
3. On `completed`, inspect `report`: `result`, `changedFiles`, `checks`, `remainingIssues`. `source:model_report` identifies model-reported data; `source:transcript_evidence` identifies a fallback built from observed file-change and command items. A successful turn is not a guarantee that all acceptance criteria passed: inspect the checks and remaining issues.
4. Call `continue_task` with a new `requestId` and `clarification:"Add a second greeting test"`. Wait again and verify `chatId` remains unchanged.

Task bindings, inputs, idempotency records and reports are persisted locally, never logged. Up to 1000 tasks and 1000 mutation records per task are retained; submissions fail rather than evicting deduplication keys. Archive storage only while the bridge is stopped, after resolving outstanding work.

After Extension Host restart the bridge observes saved chats and active turns; it never repeats the original input. If a send or connection result is ambiguous, the task becomes `error` with `recoveryRequired:true`, and its directory remains reserved. Such tasks also occupy a parallel slot until reconciliation confirms that the previous turn stopped; recovery probes run even when all slots are reserved. `recoveryRequired` is reported in `queued`, `error`, `completed` or `cancelled`; a normal `running` or `waiting_approval` task reports `false`. The flag does not prove that no turn is executing: an ambiguous turn may still be live. Restore the selected connection and inspect the chat; successful recovery reads can restore the observed running, waiting or finished state. The previous turn must be observed inactive before a new continuation can start. A definite failure before sending releases its reservation. Changing the selected connection revision blocks old tasks to avoid crossing account/connection contexts; do not switch providers with unfinished MCP work. A permanently unavailable companion or damaged chat requires manual recovery; do not delete reservations until you have verified that no turn is active.

## Local validation

`npm.cmd test` covers synthetic persistence, replay, queue, cancellation, directory exclusion, channel authentication, stdio RPC, companion discovery and panel data projection. `npm.cmd run test:browser` includes the MCP panel in Russian/English, both themes and narrow/wide layouts, including draft preservation and safe rendering. `powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/host.ps1 -TestFile mcp-host.cjs` exercises the real Extension Host with synthetic CLI and companion: submit → chat → companion preparation → report → panel continuation in the same chat → panel cancellation, and approvals. It performs no real sign-in or model inference. A real pool/model end-to-end run additionally needs the separately installed companion and its environment.
