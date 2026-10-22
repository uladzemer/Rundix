# Changelog / История изменений

## 0.4.8 — 2026-10-22

- A running CLI turn with `willRetry: true` now shows a retry status instead of a fatal error and Reconnect button. Progress, terminal completion and disconnect clear this transient status.
- Model-capacity recovery now recognizes the typed `serverOverloaded` protocol error even when its display text changes. Typed usage-limit and transport errors do not trigger capacity continuations.

## 0.4.7 — 2026-10-22

- Visible ordinary chats automatically continue a confirmed model-capacity failure in the same thread after 60, 120 and 300 seconds, at most three times. Cancel from the error card. Drafts, attachments and queued messages are preserved; changed connections/accounts/models cancel recovery. MCP/service tasks and task preparation keep their existing recovery behavior.
- Successful turns now clear transient CLI retry errors; stale terminal/error notifications cannot stop a newer turn.

Install and update Rundix through [Microsoft Marketplace](https://marketplace.visualstudio.com/items?itemName=local-rundix-tools.rundix).

## 0.4.6 — 2026-10-21

- Account menu adds limit/name sorting and shows countdowns alongside five-hour and weekly reset times.

## 0.4.5 — 2026-10-21

- Server account choices now show each account's five-hour and weekly remaining percentages with their reset times.

## 0.4.4 — 2026-10-21

- Optional connections can supply a bounded menu of choices directly in the account dialog. Opening or refreshing it reloads the provider's presentation; hidden or failed reads remove previous choices. Switching is guarded by the idle credential lease and rejects stale actions.

## 0.4.3 — 2026-10-21

- Background service: after a task chat was recreated during an account switch, the finished turn kept the project directory reserved, so the next Continue waited forever ("a turn is still running in this project directory"). The turn now follows the recreated chat and releases the directory.

## 0.4.2 — 2026-10-21

- Background service: a typed Codex usage-limit failure now records one automatic continuation in the same chat, then waits for the selected provider to confirm availability. Account selection remains in the installed provider.
- Background service: tasks restore their existing thread and configuration on a replacement CLI; task/history failures back off, then keep slow retries without occupying execution slots. Explicit Continue resets recovery; unsent input survives restarts.
- Background service: automatic limit continuations are bounded to two consecutive turns, at least 60 seconds apart; ordinary window recovery keeps the 0.4.1 behavior.
- Background service: time waiting in the task queue no longer consumes the connection startup budget.
- Background service: a turn interrupted by a Codex or service restart becomes a recoverable error — Continue resumes the same chat instead of the task being cancelled.
- Background service: a new task chat whose thread was lost by a restart before its first turn is recreated automatically instead of failing with "Execution did not start".
- Background service: a failed or interrupted turn no longer leaves the project directory reserved ("project directory is unavailable") until the service restarts.
- Background service: your own Continue is always sent, even after the automatic continuation limit; an already answered limit never triggers another automatic continuation.

## 0.4.1 — 2026-10-21

- Background service: MCP task history from 0.3.x is imported even when older task chats lack the MCP marker; tasks whose chat is missing are kept as read-only entries instead of blocking the import with "data needs repair".
- Background service: the MCP button shows the green indicator when the window is connected to the service.
- Background service: storage locations that no longer exist are removed from the import list.

## 0.4.0 — 2026-10-21

- Experimental background service (`rundix.mcpService: "service"`): MCP tasks run in a per-user background process, so Claude Code can submit, wait for and continue Codex tasks with VS Code closed. Each task belongs to the project (Git root) of the Claude session that submitted it; other projects cannot list, read or continue it, and every VS Code window shows only its project's tasks and task chats. Off by default — window mode is unchanged.
- The service starts on demand, keeps a single instance per user, survives restarts without re-running work, waits for a usage-limit reset instead of failing, and runs Codex with an ephemeral credential store so your own Codex sign-in is never touched. Tasks from 0.3.x are imported into the service.
- Service task chats render Codex reports as readable text; continuations and answers to Codex questions go through the service.
- Connection companions can provide a background connection through a versioned, fail-closed provider interface; without one, service tasks report that action is required.
- Internal: session core and MCP task hosting no longer depend on the VS Code API.

## 0.3.1 — 2026-10-20

- Fixed: after an MCP task continued (for example once the pool switched accounts on a usage limit), the delivered continuation could stay in the chat's input box. The composer now tracks who owns a draft, clears text the extension placed there once it is delivered, and never removes what you typed yourself.
- MCP: continuations that were definitely not sent are kept on the task and returned by `get_task` (full text) and shown in the MCP panel; other tool replies carry only `unsentInputCount`. A queued continuation cancelled with `cancel_task` stays recoverable.
- Internal: the session core and MCP task hosting no longer depend on the VS Code API, in preparation for running MCP tasks with VS Code closed. Behaviour is unchanged.

## 0.3.0 — 2026-10-20

Reliability and automation release. Highlights:

- Claude Code ↔ Codex over MCP is fully automatic: `wait_task`/`wait_tasks` and a background `--wait` launcher instead of polling, Codex questions routed to the agent client, parallel tasks across projects, per-task model/effort (`list_models`), `close_task`, `reload_window`, configurable access mode and per-thread Codex config.
- Safer sending: a lost `turn/start` reply is reconciled instead of resent or released early; queued follow-ups are never replayed when delivery is uncertain; adding to the queue is transactional.
- Safer storage across VS Code windows: atomic leases (with a fallback for volumes without hard links) and locked record saves so drafts are not overwritten.
- Chat: quiz answers and queued-message edits survive panel reloads (secret answers are never stored); answers with unconfirmed delivery can be re-sent after checking the chat; the configured history scope is honoured and history keeps keyboard focus.
- Security and robustness: `rundix.cliPath` is read only from user settings; a pending browser sign-in holds the account lock with a clear message and a 5-minute limit; a hung companion no longer blocks switching connections; broken CLI installs are repaired; catalog paging is bounded.
- Packaging: the VSIX audit fails if a packaged script requires a module that is not packaged.

- MCP: task chats open in focus mode; task tab titles carry the task description (shown in the tab hover; use fixed tab sizing to keep tabs narrow); `close_task` closes the tab of a finished task so tabs do not pile up; `list_models` lets the client pick model and reasoning effort per task.
- MCP: `rundix.mcpThreadConfig` applies per-thread Codex config overrides to MCP task chats only, for example to disable helper MCP servers and plugins that keep a finished task's worktree in use on Windows.
- MCP: task turns address Codex as an automated agent client, so its questions go to Claude as blocking requests; asynchronous chat quizzes in MCP task chats are surfaced as `rundix/asyncQuestion` pending requests and answered through `continue_task`.
- MCP: tasks for different projects or worktrees run in parallel, up to `rundix.mcpMaxParallelTasks` (default 3); `wait_tasks` and `--wait <id1>,<id2>` wake the client on the first task that needs attention. The shared Codex app-server no longer pins a task's worktree folder on Windows.
- MCP: new user setting `rundix.mcpAccessMode` chooses the access mode of chats created by MCP tasks, including full access; workspace settings cannot change it. MCP task chats are titled `MCP · <task description>` instead of a generic name.
- MCP: `wait_task` blocks until a task needs attention, and the launcher's `--wait` mode lets Claude wait in the background and be notified on completion, so clients no longer poll `get_task`. Tasks carry a `revision`.
- MCP: Claude's configuration now points at a stable launcher copy in extension storage that survives Rundix updates; copy the configuration once more after updating from 0.2.2.
- MCP: errors carry a code and the next step (for example how to start the bridge); `list_tasks` returns compact summaries with state/directory filters and a cursor; `effort` is honoured without `model`.
- MCP reliability: replayed cancellations and failed approvals can no longer act on a later turn; a busy directory no longer stalls tasks for other directories; a stopped bridge never starts a pending turn; reports use only the task's own turn and flag incomplete evidence; directory leases cover the enclosing git worktree and are released even if the directory was deleted. `recoveryRequired` is reported only when no turn is executing.

- Add a visible MCP button to the chat toolbar. It opens the MCP controls in an editor tab, with inline Claude configuration and a copy button, without requiring the command palette.
- Add a bilingual MCP task panel with pool connection, task reports, chat navigation, continuation and cancellation. Explicit pool connection discovers installed companions and reuses the selected working provider.
- Add an opt-in local MCP bridge for Claude Code: asynchronous tasks, durable chat bindings and request deduplication, same-chat continuations, approval forwarding and cancellation.
- Reuse the selected companion's existing executor and limit preparation; protect local IPC and serialize directory changes across Rundix chats. See `docs/mcp.md` for setup and recovery limits.

## 0.2.2 — 2026-10-18

- Added a Microsoft Marketplace installation badge and a 29-second, seven-scene tour of a real VS Code window: native chat tabs, grouped history, split code/chat layout, follow-up queue, access modes and Russian questions in the light theme.
- Added version notes and feedback links. Microsoft Marketplace is the only distribution channel promoted in the documentation.
- Documentation and package presentation only; chat, history and connection behavior are unchanged.

Добавлены значок установки из Microsoft Marketplace, 29-секундный тур по настоящему окну VS Code с вкладками, историей, кодом рядом с чатом, очередью и вопросами в светлой теме, история изменений и ссылки для обратной связи. Работа чатов, истории и подключений не менялась.

## 0.2.1 — 2026-10-18

- Reworked the English and Russian descriptions around features, setup and settings.
- Added search keywords and a Marketplace category.
- Included the connection API v1 groundwork from 0.2.0: explicit companion selection, fail-closed sending when a selected provider is missing, and conflict-preserving import of legacy conversation metadata.

Обновлены описание на двух языках, поисковые теги и категория. Включён API подключения v1 из основы 0.2.0: явный выбор модуля, сохранение черновика при его недоступности и перенос метаданных прежних чатов без перезаписи конфликтов.

## 0.1.1 — 2026-10-18

- Initial Marketplace version of the independent Codex CLI interface: native chat tabs, images, queued follow-ups and local CLI sign-in.

Первый выпуск в Marketplace: независимый интерфейс Codex CLI с вкладками чатов, изображениями, очередью уточнений и текущим локальным входом CLI.
