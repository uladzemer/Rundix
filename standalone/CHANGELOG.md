# Changelog / История изменений

Install and update Rundix through [Microsoft Marketplace](https://marketplace.visualstudio.com/items?itemName=local-rundix-tools.rundix).

## Unreleased

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
