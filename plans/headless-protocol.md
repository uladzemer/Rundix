# Headless Rundix: протокол этапа 1

> Исторический дизайн этапа 1 от 20 октября 2026 года, а не отчёт о текущей реализации. Контракты и готовность следует сверять с исходниками и актуальной документацией в standalone/docs.

**Решение D00 — область документа.** Проект serviceProtocol:1, без реализации. Решения владельца headless-architecture.md §8 и 2026-10-20 обязательны; примеры синтетические, placeholders. Вопросы §13; лог отражает design fixes, не runtime evidence.

**Решение D01 — исходная база.** Main dc7cecd, не worktree 8228cb5. Source claims по extension.startMcp, mcp-bridge.installLauncher/serve, task-directory.key, SessionStore.write/acquire; AGENTS.md/REVIEW.md, connection-api.md, headless-service.md.

## 1. Процессы и владение

**Решение D02 — один MCP owner.** Один user service владеет MCP tasks/chats/executor/queues/approvals/recovery; windows/stdio — клиенты. Один app-server, один confirmed provider binding, parallel turns default 3/max 5. Смена binding только idle (§9).

**Решение D03 — обычные чаты остаются оконными.** Их executor, app-server, connection API v1, drafts, `sessions-v1` и leases остаются в окне как сегодня, без зависимости от сервиса. MCP вкладка содержит `{owner:"service",spaceId,taskId,chatId}` и отображает service session; send/answer/cancel идут сервису, не локальному executor. История объединяет локальные чаты и service projections с разными owners. Продолжение MCP chat сохраняет taskId/chatId, даже после завершения. Disconnect adapter, close/reload окна не прекращают service turns.

**Решение D04 — leases только между MCP tasks сервиса.** Использовать **точно** `task-directory.key`: `canonical(directory)` → ближайший предок с `.git` → `sha256(ancestor)` без platform/version prefix, вне git — `sha256(canonical(directory))`. `canonical` использует realpath и Windows lowercase. Собственная `.git` file вложенного worktree задаёт независимую execution boundary. Общий service directory store для всех spaces исключает одновременные MCP turns одного worktree. Busy error/progress не содержит чужих taskId, spaceId или paths. `waiting_limit` сохраняет durable reservation до terminal/cancel, но не держит execution/credential lease или parallel slot.

**Решение D05 — ограничение координации.** Ручной чат использует прежний window-local store; сервис не выдаёт ему `directory.acquire/reconcile`. Ручной чат и MCP task одного каталога между разными stores не координируются сверх сегодняшнего поведения. Возможное предупреждение окна по snapshot — не lock. Не запускать такой сценарий как доказательство mutual exclusion.

## 2. Space identity

**Решение D06 — источник space.** Adapter фиксирует launch directory при старте: непустой абсолютный существующий `CLAUDE_PROJECT_DIR` имеет приоритет, иначе сохранённый adapter cwd. Неверный непустой env → `space_invalid_directory`, без выбора другого проекта. `roots/list` — только необязательная диагностика после ответа на MCP initialize: asynchronous budget 2 s, без ожидания со стороны tools/stdio; при заданном env запрос вообще не требуется. Timeout, несовпадение roots, `--add-dir` и roots changes не меняют binding и не блокируют tools. Roots не являются источником прав или fallback пространства этапа 1. `CLAUDE_CODE_SESSION_ID` — только корреляция.

**Решение D07 — простая канонизация.** Проверить absolute directory, NUL и существование; `fs.realpathSync.native` разрешает junctions/symlinks. Windows: убрать эквивалентный DOS prefix `\\?\C:\...` → `C:\...`, UNC prefix `\\?\UNC\host\share\...` → `\\host\share\...`, нормализовать через `path.win32.normalize`, убрать trailing separator кроме root и применить **toLowerCase ко всему пути**, включая drive letter. Device namespaces `\\.\`, `GLOBALROOT` запрещены. macOS — native realpath и `path.normalize`, без lower-case/самодельной Unicode-нормализации. Одна функция для adapter/window/service; сервис проверяет root заново.

**Решение D08 — git root без запуска git.** Только bounded filesystem traversal, без git subprocess, hooks или чтения git config.

1. От canonical launch directory идти вверх до ближайшей `.git`. Directory `.git` → root пространства равен содержащему её каталогу.
2. File `.git` (≤4 KiB) должна содержать одну строку `gitdir: <path>`; относительный path разрешить от содержащего `.git` каталога, затем realpath. Если `<gitdir>/commondir` существует, прочитать один path (≤4 KiB), относительно gitdir, затем realpath. Лимиты: 256 ancestors, цепочка служебных ссылок 8 переходами; цикл/повреждение → `space_git_invalid`.
3. Common directory с canonical basename `.git` задаёт основной root = его parent. `.claude/worktrees/<name>/.git` → gitdir → commondir основного repo даёт тот же space; это не объединение по строковому префиксу `.claude`. Внешние linked worktrees того же common directory также разделяют space. Execution keys из D04 остаются разными.
4. Нет commondir, gitdir нестандартный (submodule/separate-git-dir) → ближайшая проверенная рабочая папка с `.git` file является root собственного space. Linked layout, у которого common directory не является `.git`, → `space_git_layout_unsupported`, без угадывания основного checkout. Вложенный самостоятельный repo остаётся самостоятельным.
5. Нет markers до filesystem root → `kind:"directory"`, root равен точному launch directory. Его негитовый подкаталог, выбранный другим launch directory, — другой space. Недоступный marker/path → `space_invalid_directory`; malformed marker не превращать в non-git fallback.

**Решение D09 — ключ и границы FS.** `spaceId = sha256("rundix-space-v1\0" + platform + "\0" + kind + "\0" + canonicalRoot)` после D07. `projectDirectory` может быть в другом repo и не входит в binding: задача принадлежит **отправившему Claude**, не execution directory. Binding неизменен на connection; другой launch repo требует нового adapter. NTFS case-sensitive directories и macOS aliases с нестабильным регистром не получают дополнительных identity-гарантий этапа 1 (§12). Rename repo даёт новый space, auto relocate отсутствует.

**Решение D10 — окно и trust.** `trusted:false` → `workspace_untrusted` **до любой** roots/task/window metadata: без snapshots/events/legacy history. При отзыве trust host закрывает соединение и очищает webview projection. Каждая local workspaceFolder вычисляет space D07–D09; multi-root — множество bindings, одинаковые repo схлопываются. Panel имеет space selector, default — folder активного редактора, иначе первый folder; adapter этим выбором не управляется. Empty window не имеет task space. Virtual/remote URI на локальном сервисе → `space_unsupported_uri`; удалённый Extension Host и Claude используют сервис на общем host.

## 3. Transport, singleton и запуск

**Решение D11 — Node-only IPC.** Использовать `node:net`, без native addons. Fixed endpoint: Windows `\\.\pipe\rundix-service-v1-<userKey>`, `userKey=sha256(OS SID).slice(0,24)`; macOS `/tmp/rundix-<uid>/service-v1.sock`. SID получает штатная PowerShell команда, UID — `process.getuid()`. Имя не содержит generation/product version. `listen` winner — owner; `EADDRINUSE` означает другого listener, проигравший не создаёт CLI/executor и не пишет discovery/tasks.

**Решение D12 — private discovery и доверие.** `serviceRoot` = `%LOCALAPPDATA%\Rundix\service` либо `~/Library/Application Support/Rundix/service`. Подход `mcp-bridge.privateDirectory`: `icacls` с current SID и SYSTEM, без inheritance; macOS directories 0700, files 0600, socket directory private. Проверить owner/отсутствие symlink существующего `/tmp/rundix-<uid>`. Secret 32 random bytes hex, только private discovery, не env/command line/UI/logs; HMAC challenge-response в hello (D15). Native pipe DACL/peer UID проверки отсутствуют. **Space isolation защищает от ошибок маршрутизации, не от hostile same-user code**; same-user процессы имеют доступ к capability.

```json
{"version":2,"endpoint":{"kind":"named_pipe","address":"\\\\.\\pipe\\rundix-service-v1-<userKey>"},"status":"starting","serviceVersion":"<semver>","protocol":{"min":1,"max":1},"pid":42420,"processStart":"<OS creation time>","generation":"<uuid>","secret":"<64 hex>","entryPath":"<absolute installed service entry>"}
```

**Решение D13 — publication/start race.** `<serviceRoot>/bridge.json` пишется temp+rename на том же volume, как `SessionStore.write`. После успешного listen немедленно заменить stale descriptor новым `status:"starting"`, до загрузки tasks/миграции; ping отвечает starting. После recovery/legacy leases (§7) заменить на ready. Для macOS stale socket cleanup и краткой секции listen→starting использовать существующий Node file-lease `SessionStore.acquire('service-startup')`: это guard cleanup race, не второй singleton. Под guard перечитать descriptor: новый/живой/starting owner запрещает unlink. Только доказанно мёртвый старый pid+processStart разрешает удалить stale socket; guard держать до starting publication. На shutdown удалить только свой descriptor/socket под этим guard после прекращения admissions и закрытия connections.

**Решение D14 — spawn, timeout, hung owner.** Adapter/window: connect budget 2 s, hello/ping 5 s. Нет отвечающего listener → `spawn(absoluteNode,[installedEntry],{shell:false,detached:true,windowsHide:true,stdio:"ignore"}).unref()`. Entry регистрирует trusted установка, не workspace; digest/current/bundle protocol отсутствует. Concurrent spawn допустим, listen решает владение. До **полного** startup deadline 20 s клиент перечитывает discovery с backoff 100–1000 ms; starting — ожидать, не kill/error. После deadline → `service_start_timeout`; adapter message: «Service owner is not responding. Run the installed launcher with --recover-hung, then retry with the same requestId.»

Hung recovery — явная команда launcher `--recover-hung`: повторить ping, сверить pid **и OS process start time** из discovery с текущим процессом (Windows bounded PowerShell Get-Process/CIM, macOS `ps` с фиксированными locale/TZ, shell:false), сверить service entry. Только совпадение и повторный ping timeout разрешают остановить service и зарегистрированных children с проверкой их pid/startTime, дождаться смерти, удалить stale socket под guard и demand-start. Несовпадение/невозможность проверки → `owner_unverified`, без kill. Нет автоматического kill-loop. До нового turn старый CLI должен быть подтверждённо остановлен, иначе `recovery_required`; history/drafts доступны.

**Решение D15 — hello и framing.** IPC, как MCP stdio, — newline-delimited JSON-RPC 2.0, один JSON на строку, без batch; ≤1 MiB UTF-8 на сообщение. Incremental parser ограничивает именно текущую строку, incomplete frame timeout 5 s. Клиент **сначала ping**, сверяет generation/status и получает serverNonce (32 random bytes, one-use, connection-bound, TTL 5 s); затем hello с proof = HMAC-SHA256(discovery secret, UTF-8 `rundix-service-v1\0` + generation + `\0` + serverNonce), hex. Server constant-time проверяет proof и consumes nonce; secret не передаётся. До authenticated hello только ping/hello, без task данных. При auth_failed в startup window перечитать discovery и повторить ping/hello с backoff в общем 20 s budget, без spawn/kill по auth_failed. Replay/expired nonce отвергается. Generation меняется на каждом запуске; post-hello requests содержат generation/bindingId/spaceId. Клиент проверяет connection/generation/id; executor/provider callbacks дополнительно canonical fences §9, stale результат игнорируется.

```json
{"jsonrpc":"2.0","id":"h1","method":"service.hello","params":{"protocol":{"min":1,"max":1},"serverNonce":"<nonce>","proof":"<hmac-hex>","generation":"<uuid>","clientKind":"adapter","clientVersion":"<semver>","binding":{"launchDirectory":"C:\\Synthetic\\RepoA","source":"claude_project_dir"},"capabilities":["tasks.v1","limitWait.v1","windowControl.v1","spaceSnapshot.v1"]}}
```

**Решение D16 — window hello и budgets.** Window binding вместо launchDirectory: `{workspaceFolders:["<local workspace folder URI>"],trusted:true,windowId:"<uuid>"}`; service вычисляет spaces и сохраняет folders для legacy projection. Task RPC — 12 s, availability 8 s, catalog 9 s; длительная provider preparation идёт в scheduler, вне submit response. Wait transport = waitSeconds+15 s. Ping 15 s с budget 5 s; reconnect backoff 0.25–5 s, перечитать discovery/hello/полный snapshot. Disconnect убирает waiter/subscription, не задачу. Reads можно повторять, mutations — только с прежним requestId/arguments. `--wait` reconnect до собственного deadline (1–86400 s).

**Решение D17 — errors/scoping.** Проверять auth/generation/binding, затем task принадлежность, затем его connection/idempotency/state. Чужой/отсутствующий taskId → одинаковые unknown_task/message; mixed wait_tasks — целиком unknown_task без частичного ответа. Space вне binding → space_not_bound, без проверки существования. Busy errors/progress не раскрывают чужие IDs/paths. Unexpected exception → `rejected: Request rejected`. Adapter возвращает MCP `isError:true`, `<code>: <safe message>`. JSON-RPC parse/unknown method: -32700/-32601.

| Группа | Codes |
| --- | --- |
| Space/trust | `space_invalid_directory`, `space_git_invalid`, `space_git_layout_unsupported`, `space_unsupported_uri`, `space_not_bound`, `workspace_untrusted` |
| Lifecycle | `auth_failed`, `protocol_incompatible`, `stale_instance`, `service_unavailable`, `service_start_timeout`, `service_initializing`, `owner_unverified`, `recovery_required`, `service_busy`, `ipc_security_unavailable` |
| Tasks | `unknown_task`, `invalid_argument`, `invalid_directory`, `request_conflict`, `task_active`, `directory_busy`, `connection_unavailable`, `provider_unavailable`, `approval_not_pending`, `approval_rejected`, `delivery_unknown`, `response_too_large`, `storage_unavailable`, `limit`, `rejected` |
| Window/legacy | `window_unavailable`, `window_ambiguous`, `window_control_unknown`, `legacy_owner_active`, `migration_conflict`, `adapter_upgrade_required`, `service_upgrade_required` |

## 4. MCP tools внутри space

**Решение D18 — idempotency/capabilities.** Сохранить contracts 0.3.0, кроме указанных расширений. Только submit/continue/cancel требуют requestId (≤128 chars, рекомендован UUID). Key `(spaceId,requestId)`, fingerprint stable JSON имени+полных arguments; разные arguments → request_conflict, replay → snapshot прежней задачи без новой отправки. Dedup включает архив. Hello capabilities — пересечение возможностей клиента/сервиса; clientKind отдельно ограничивает доступные RPC methods. Adapter строит **tools/list и допустимые fields/enums из negotiated hello capabilities/toolSchemaVersion**, не своей package version; несогласованные поля отклоняются, не исчезают молча. MCP initialize отвечает сразу, сохраняя версии 2025-11-25/2025-06-18/2024-11-05; tools/list затем ждёт bounded hello/startup.

**Решение D19 — все tools.** Таблица действует только в bound space; окно вызывает тот же task.call для send/answer/cancel.

| Tool | Arguments → результат/ограничения |
| --- | --- |
| `submit_task` | `{requestId,description,projectDirectory,acceptanceCriteria,model?,effort?}` → persisted queued snapshot **до model execution**. Directory absolute/existing canonical, может быть в другом repo. Проверить provider/legacy gates, сохранить idempotency; preparation асинхронно. Default access/thread config только user-owned service settings, не workspace/adapter. |
| `get_task` | `{taskId,brief?:false}` → snapshot D22/§9: waitingLimit, revision, progress, chatId, timestamps, accessMode, pendingRequests, queuedContinuations, recoveryRequired, report/error. Brief заменяет report на прежний reportSummary: preview 500 chars, resultLength, changedFiles, checksCount/remainingIssuesCount. Архив доступен по тому же ID. |
| `wait_task` | `{taskId,waitSeconds?:600,afterRevision?,brief?:false}`. Wait 1–1500 s; waking states только completed/error/cancelled/waiting_approval; afterRevision требует большую revision. queued/running/**waiting_limit не будят**, limit checkpoints в §6. Snapshot + timedOut. |
| `wait_tasks` | `{taskIds,waitSeconds?:600,brief?:false}`, 1–50 unique IDs → `{settled:[snapshots],waiting:[taskIds],timedOut,waitingLimits:[{taskId,resetAt,reason}]}`. Последнее поле — negotiated limitWait.v1 расширение; waiting_limit не попадает в settled. Проверить все IDs до ожидания. |
| `list_tasks` | `{limit?:25,state?,projectDirectory?,cursor?}`, limit 1–100 → `{tasks:[summary],nextCursor}`. Сначала space filter, затем directory/state/cursor; newest created first, taskId tie-break. Cursor как сегодня: base64url(`createdAt:taskId`), malformed → invalid_argument. Без HMAC: чужой cursor не выдаёт чужие данные после space filter. Архив включён без дублей. |
| `continue_task` | `{requestId,taskId,clarification}` либо `{requestId,taskId,approval:{id,decision?,answers?,skip?,content?}}`, ровно один вариант. Тот же chatId. Clarification active/waiting_limit → durable FIFO (≤20); finished → queued, archive возвращается в hot storage. Неоднозначная отправка блокирует resend даже с новым requestId до reconciliation. Approval проверяет task/run/server/pending request; не auto-approve и не acceptForSession. |
| `cancel_task` | `{requestId,taskId}` → durable cancellation, очистить queued/unsent auto-continuation. queued/waiting_limit без live turn → cancelled и снять reservation; running/approval → interrupt, cancelled только по подтверждению. Replay старого cancel не отменяет поздний continuation. |
| `close_task` | `{taskId}`: только terminal без live/recovery turn, иначе task_active. Сохранить closedAt/visibility closed, уведомить subscribed окна space. `{taskId,state,chatClosed,windowsNotified}`; без окна успешно `{chatClosed:false,windowsNotified:0}`. Draft-aware вкладка сохраняет draft до закрытия. История остаётся, open/continue снимает закрытие; кандидат archive (§7). |
| `list_models` | `{}` → `{models:[{model,displayName,isDefault,defaultEffort,efforts}]}` service provider без account details. Service сам делает hello → idle grant → authenticate(trigger:catalog) до catalog RPC без task admission; existing confirmed grant переиспользуется, active context не меняется. Budget 9 s; pending login → connection_unavailable; shared preparation может завершиться позже под исходным fence. Недоступный catalog/connection → connection_unavailable, не ложный пустой список. |
| `reload_window` | `{force?:false,windowId?}`. Только trusted окна bound space. Нет → window_unavailable; несколько без ID → window_ambiguous; чужой ID → window_unavailable. `window.reload` проверяет manual busy chats/несохранённые UI mutations, без force → task_active; service turns не мешают. ACK → `{reloading:true,windowId}`, потеря ACK → window_control_unknown без auto retry. Reload только target window, не сервис/другие окна. |

## 5. Snapshots и chat в окне

**Решение D20 — полный snapshot на (re)subscribe.** `space.subscribe {spaceId,limit?:100}` → space.snapshot, schemaVersion:1, viewRevision внутри generation. Полная замена UI projection: ≤100 recent task/chat summaries (active первыми), totals/hasMoreHistory; прочая история через обычный list_tasks cursor. Нет immutable pagination/replay log. `space.changed` сообщает новую viewRevision, окно перечитывает snapshot; старые revision игнорируются, reconnect всегда полный срез. `windows[]`/`window.presence` содержат только окна, связанные с **этим subscription space**, без чужих folders/IDs.

```json
{"jsonrpc":"2.0","method":"space.snapshot","params":{"generation":"<uuid>","spaceId":"<space-A>","schemaVersion":1,"viewRevision":12,"tasks":[{"taskId":"<task-id>","state":"waiting_limit","revision":8,"chatId":"<thread-id>","waitingLimit":{"resetAt":1800000300000,"reason":"exhausted"}}],"chats":[{"taskId":"<task-id>","chatId":"<thread-id>","owner":"service","title":"MCP · Synthetic task","visibility":"open"}],"windows":[{"windowId":"<window-A>"}],"totalTasks":1,"hasMoreHistory":false}}
```

**Решение D21 — вкладка/bounded projection.** `chat.open/subscribe {taskId}` → chat.snapshot: metadata, pendingRequests, последние ≤200 transcript items, historyTruncated/itemsTruncated. Большой display item укорачивается до 16 KiB, общий snapshot ≤768 KiB; task input/intent/report не обрезается в storage ради UI. Старые items читаются через существующий bounded CLI history path с обычным cursor, без immutable slices/chat.item.part. Огромный report в MCP → response_too_large и retry brief; UI явно показывает truncation. На изменение — полный chat snapshot; медленный subscriber (queue >2 MiB) отключается/resync, executor продолжает работу. MCP panel показывает state/resetAt/progress/report/questions, вкладка — привычный transcript с service owner. Send/answer → continue_task, cancel → cancel_task; draft/requestId сохранены до ACK, failed ACK не стирает draft.

## 6. `waiting_limit` и автоматическое продолжение

**Решение D22 — state/waits.** Enum: queued/running/waiting_approval/**waiting_limit**/completed/error/cancelled. `waitingLimit:{resetAt:number|null,reason}` только в waiting_limit, иначе null; timestamps UTC ms. В wait_task/wait_tasks progress/revision или вход в waiting_limit **не будят** waiter. Нет waking task → блокировать до `min(clientDeadline, ближайший будущий resetAt)`; checkpoint возвращает `timedOut:true` с waitingLimit, не завершение. Просроченный resetAt запускает fresh preparation, waiter ждёт следующий future reset/deadline либо waking state, не зацикленно старое время. resetAt:null → clientDeadline или waking task. Не менять revision при неизменной проверке квоты.

**Решение D23 — preparation/poller.** Pre-send wait сохраняет unsent attempt/directory reservation, освобождает parallel/execution/credential slots. **Service** владеет одним poller на выбранный provider и одним in-flight prepareTurn(mode:probe). Unknown backoff 1 → 2 → 4 → 8 → 15 min, затем 15 min; retryAfterMs — нижняя граница следующего запроса, включая coalesced idle/config/explicit-refresh wake. Wall-clock tick ≤30 s (target 15 s), Date.now сверяет resetAt/nextCheckAt; sleep/jump не доказывает ready. Known due и turnTerminal при idle запускают fresh probe, затем fresh admits; 100 waits не дают 100 probes. Cancel representative выбирает другой waitId, не гасит poller. Применять только к живому waitId с global fence, не taskRevision. Auth failure → action_required по §9, не quota polling.

**Решение D24 — exhaustion внутри turn.** Источник — **typed CLI limit error**, не regex/текст и не provider event. Service закрывает admissions binding, ждёт terminal/confirmed interrupt; до этого running/recovery и занятый slot. Затем prepareTurn(mode:probe) получает resetAt либо RESET_UNKNOWN; исход по §9. Сохранить waiting_limit и один intent `(taskId,exhaustedTurnId)`: `Continue the previous task from its saved state. Do not repeat completed actions. Finish with the requested report.` После fresh admit отправить его **первым**, затем clarifications FIFO ≤20, каждую после предыдущего terminal; original input не replay. Crash использует тот же watermark D27–D28, unknown delivery не создаёт второй continuation. Новое exhaustion — новый waitId; cancel удаляет unsent continuation/FIFO.

**Решение D25 — cancel/--wait/reboot.** Cancellation сохраняется раньше удаления wait/unsent continuation и освобождения reservation; wake/cancel сериализованы per-task queue. `--wait` печатает единственный финальный stdout JSON, на timedOut:true продолжает до своего deadline, при необходимости делает backoff; waiting_limit не exit 0, task text не попадает в diagnostics. Snapshot последнего checkpoint показывает resetAt. После OS reboot нет автозапуска: следующий adapter/window поднимает сервис и возобновляет waits, просроченный reset перепроверяется.

## 7. Storage, intent и миграция 0.3.0

**Решение D26 — простой layout.** Atomic JSON replace как SessionStore.write (temp+rename на том же volume), один writer/per-task serial queue; revision только при изменениях. Inputs/operation keys/reports — private records, не logs/fixtures/package. MCP sessions сохраняет service через адаптированный session-persistence.save; manual sessions остаются в VS Code storage. Нет per-revision/head/commit/digest файлов, replay log или credential import.

```text
<serviceRoot>/
  bridge.json
  settings.json                   # только user MCP defaults; provider.json отдельно
  legacy-roots.json               # явно зарегистрированные legacy roots
  coordination/                   # task-directory-<key>.json, только MCP
  spaces/<spaceId>/
    space.json
    tasks/<taskId>/task.json       # state, operations, queued inputs
    tasks/<taskId>/intent.json     # watermark/текущая внешняя mutation
    archive/<taskId>/task.json     # тот же формат/ID
    archive/<taskId>/intent.json
  sessions-v1/session-<key>.json    # только service MCP sessions
  legacy/<sourceId>/              # read-only history без launch space
  migrations/<sourceId>.json       # receipt проверки copy/cutover
  diagnostics/                    # только codes/counts, rotation 3 x 1 MiB
```

**Решение D27 — intent/watermark.** До submit ACK сохранить task/requestId; до внешнего model send — небольшой intent. Порядок: thread/start **без user input**, затем durable chatId в task/session, затем intent с chatId/watermark, только потом turn/start. Crash с chatId:null при таком порядке → model notSent: error, recoveryRequired:false, освободить slot/reservation; orphan empty thread не исполняет модель. dispatching без chatId — повреждение, не повод угадать успешную отправку.

```json
{"schemaVersion":1,"taskId":"<task-id>","requestId":"<request-id>","runId":"<run-id>","kind":"input","phase":"dispatching","chatId":"<thread-id>","generation":"<uuid>","providerGeneration":"<uuid>","configRevision":7,"binding":{"appServerId":"<cli-id>","appServerGeneration":"<uuid>","accountRevision":3,"leaseId":"<grant-id>","leaseRevision":1},"watermark":{"lastTurnId":"<previous-turn>","lastItemId":"<previous-item>","itemCount":12},"input":"Synthetic continuation","inputHash":"<sha256 canonical input>","turnId":null}
```

**Решение D28 — reconciliation, не resend.** Phases: prepared/dispatching/acknowledged/applied/unknown/rejected. Intent пишется **до** mutation, task получает outcome после неё; intent не удаляется до durable task update. Crash между файлами восстанавливается по requestId/runId. prepared без dispatching доказанно не отправлен. Input-producing send/answer становится applied **только** по новому user item после watermark с совпадающим canonical input/hash и новым turn/item identity: старый такой же текст и один RPC ACK недостаточны. Загружать CLI history до watermark, неполный transcript → delivery_unknown. Raw permission reply без нового user item фиксируется как acknowledged по точному ACK того же request/server/run, а не applied; потеря ACK → unknown, исчезновение вопроса не success. Replay acknowledged reply также не отправляет его второй раз.

Unknown input блокирует resend даже с новым requestId. После подтверждённой смерти/terminal старого CLI slot освобождается, history/unknown intent остаются для явного решения; пока turn может быть жив, slot/reservation удерживаются, recovery D14. Recovery probes работают и при занятых всех slots. Storage error до send запрещает отправку; после send не разрешает retry. Повреждённый JSON не заменяется пустым task.

**Решение D29 — archive вместо lifetime ceiling.** После close terminal task архивируется автоматически, если closedAt старше 30 суток **или** hot closed tasks переполняют 1000 recent cache; каталог task+intent переносится atomic rename на том же volume. Archive/sessions читаются по прежним IDs/list_tasks; continuation возвращает каталог в hot storage и ту же session. Dedup keys не удалять: replay search включает archive, index производный. Нет hard limit 1000 lifetime tasks/space; 1000 operations/task и 20 queued continuations сохраняют limit без потери history. Открытая terminal task не мешает submission лишь числом исторических records.

**Решение D30 — migration gate/старый lease.** Known legacy roots регистрирует trusted установка/окно из globalStorageUri либо новый launcher из явно сохранённого legacy --bridge path; не сканировать профили/credentials. До admissions получить `SessionStore(<legacyRoot>/sessions-v1).acquire('mcp-bridge')` **в каждом зарегистрированном migrated root и держать release до завершения service**, включая idle/update период. Живой old owner → legacy_owner_active, новые MCP turns не запускать/источник не менять. В extension.startMcp этот lease действительно берётся **до installLauncher**, McpTasks и serve: old window не перепишет descriptor/shim и не запустит второй MCP executor, пока сервис жив.

**Решение D31 — copy → verify → marker.** Импортировать связанные с legacy tasks MCP sessions, не ручные чаты/auth/provider state. Всё под lease D30; idempotent receipt по canonical source root и task/session IDs:

1. Штатно остановить old bridge; active legacy tasks/CLI должны быть остановлены или проверены как неисполняющиеся, одного мёртвого host PID недостаточно. Скопировать `<legacyRoot>/mcp/tasks/mcp-task-<id>.json` и связанные `sessions-v1/session-<key>.json` в service legacy bucket/staging; source сохранить.
2. Verify canonical JSON, полноту связей/IDs, source fingerprints и неизменность source под lease. Тот же source/данные — no-op, конфликтующий ID/повреждение — migration_conflict без overwrite. **Весь legacy import только read-only history**, queued inputs не попадают в новый executor.
3. После verify записать receipt и source marker `mcp/service-migration.json`. При cutover переместить source `mcp/tasks` в `<legacyRoot>/mcp/backup-<sourceId>/tasks`; backup создаётся один раз/не затирается. До окончания move/проверки receipt admissions закрыты. Crash повторяет verify/marker/недостающий move, не второй импорт; existing backup при отсутствующем active tasks — источник resume.
4. New launcher/shim — **`<serviceRoot>/bin/mcp-server.cjs`**, descriptor — `<serviceRoot>/bridge.json`, вне old installLauncher paths. Main dc7cecd `standalone/extension.cjs:startMcp` (347–357) берёт sessions-v1 lease до installLauncher с root=`<legacyRoot>/mcp`; `standalone/runtime/mcp-bridge.cjs:installLauncher` (75–89) заменяет **`<legacyRoot>/mcp/bin/{mcp-bridge.cjs,version.json,mcp-server.cjs}`**, server last, через PID tmp+rename. `<legacyRoot>/mcp/bridge.json` пишет **serve** (53), не installLauncher. После idle-exit old window снова может заменить old bin/descriptor: устойчивый shim по старому пути **не обещан**, replacement Rundix MCP entry на serviceRoot launcher **обязателен**, соседние entries не менять. Receipt/backup защищают history; новый launcher проверяет receipt, получает legacy leases, живой old bridge → legacy_owner_active, не proxy. Source sessions/ручные чаты сохраняются.

Основание: сохранность source/crash-safe повтор без migration.resolve/relocate, auto-rollback или многофазной БД.

**Решение D32 — legacy/downgrade.** Launch space 0.3.0 неизвестен; projectDirectory мог быть cross-repo. Import → legacy:<sourceId>, readOnly, без queued execution/approval/reservation/slots. Только trusted window legacy.list/get/chat, stored canonical projectDirectory внутри workspaceFolders (path.relative separator boundary), без lookup удалённого cwd. Adapter task.call IDs не видит. Новое исполнение — явная новая task/requestId. Downgrade только stopped service + выбранный backup вручную, без auto reverse migration.

## 8. Совместимость, idle-exit и update

**Решение D33 — idle-exit.** idleExitMs=300000: нет non-terminal tasks (включая waits), потенциально живых turns/recovery, windows/connections. Client/task сбрасывает timer. service.exitIfIdle {targetVersion} атомарно исключает только caller connection/window: пусто → exiting:true/close/exit, иначе exiting:false/serviceVersion/reason non_terminal_tasks|clients_connected. Новый client ждёт listener close/process exit/legacy lease release в startup budget, затем demand-start новой версии. Не снимать живой lease насильно, forced update/handover нет.

**Решение D34 — version skew.** Hello сообщает version/protocol/toolSchemaVersion/capabilities; negotiated tools/arguments только по ним. Busy compatible old service продолжает работу, update до idle. Incompatible → protocol_incompatible без task payload. Installed absolute Node/service entry только trusted user registration, не workspace; runtime живой версии не удалять. Нет digest/current bundle protocol.

**Решение D35 — compatibility/user MCP entry.** ID local-rundix-tools.rundix/server rundix/settings/commands прежние. New launcher D31 сохраняет cwd/env/--bridge/--wait/--timeout/--brief. Legacy --bridge проверяет receipt → service discovery, executable только trusted install. Old launcher path после idle-exit может перезаписать старое окно: replacement MCP JSON **обязателен**, без автоматической правки соседних entries. Live adapter 0.3.0 требует restart, v1 endpoint error-only.

| Пара | Поведение |
| --- | --- |
| Новый adapter → новый service | Hello/capabilities, negotiated tools/list, launch binding. |
| Новый adapter → old HTTP bridge v1 | service_upgrade_required, не proxy tasks в неспейсовый executor; сначала остановка/миграция old owner. |
| Старый путь launcher | Временный shim ненадёжен после idle-exit: заменить MCP entry на serviceRoot launcher, restart adapter. |
| Уже работающий adapter 0.3.0 → service | Из HTTP `{name,arguments}` launch space не восстановить. Для migrated root сервис держит v1 **error-only** HTTP endpoint на 127.0.0.1 с прежними bearer/origin/size guards; legacy bridge.json остаётся `{version:1,port,secret}` для него, root service discovery отдельно v2. Все calls → adapter_upgrade_required, без tasks/history. Это safe отказ, не функциональная прозрачная совместимость; не выбирать space по projectDirectory/окну. |
| Old adapter после остановки сервиса | bridge_unavailable до нового запуска. Уже загруженный JS 0.3.0 shim не заменит: нужен restart MCP process средствами Claude, где не поддерживается — restart Claude. UI предупреждает до cutover, backup остаётся. Проверка целевой Claude версии — Q2. |

## 9. Public provider hook

**Решение D36 — generic provider hook.** Выбранный installed provider обязателен; отсутствие/incompatible → provider_unavailable/connection_unavailable, без local fallback. Connection API v1 ручных чатов прежний. Контракт ниже не определяет provider implementation.

**Решение D37 — normal CODEX_HOME (владелец, 2026-10-20).** Service app-server использует **обычный пользовательский CODEX_HOME**, как сегодня: config.toml, skills, global MCP servers/plugins и расположение history сохраняются. Нет cli-home/копирования пользовательских файлов. Safety — hard gate: **никакого turn/start до confirmed external provider login текущих account grant/appServerGeneration**; personal account/read не proof, spawn/reconnect/provider loss сбрасывают proof. mcpThreadConfig-style per-task model/reasoning/sandbox/approval overrides поверх user config сохраняются; workspace/adapter не повышает доступ. Service-owned task IDs/projection определяют routing при общем history location. Обязателен synthetic normal-home test: external auth не перезаписывает личный sign-in file; pinned CLI evidence пока открыт (Q3).

### Provider interface v2 (нормативный контракт)

Length-prefixed JSON-RPC 2.0: uint32 BE + UTF-8, ≤256 KiB/frame, ≤32 in-flight, queue ≤1 MiB, partial frame 5 s; batch/duplicate keys запрещены. Request/result/events имеют `fence`, requests — `timeoutMs`. Hello согласует major 2/minor 0; capabilities содержат **все** method/event names таблицы, иначе incompatible. Unknown method → METHOD_NOT_SUPPORTED. Callback не отправляет model input.

| Направление / method или event | Контракт / deadline |
| --- | --- |
| service → provider `hello` | versions, providerId/version, global fence → version/capabilities; 5 s |
| service → provider `authenticate` | appServerId, trigger initial/reconnect/catalog → authenticated(accountRevision) / unavailable; 70 s; service idle grant |
| service → provider `prepareTurn` | taskId, spaceId, attemptId, waitId?, mode:admit/probe, interactiveClientAvailable; taskRevision только информация → ready / waitUntil / needsDecision / unavailable; 90 s, один in-flight |
| service → provider `handleRequest` | outstanding typed CLI request → cliResponse(requestId,response), один ответ CLI; 9 s |
| service → provider `cancelWait` | waitId → cancelled(waitId); 3 s, idempotent, taskRevision отсутствует |
| service → provider `configureByClient` | clientId, operationId, expectedSelectionRevision, opaque action/payload → configured / pending / unavailable; 15 s, configuration capability |
| service → provider `status` | summary либо operationId → status / pending / succeeded / failed / uncertain; 3 s, без sensitive payload |
| service → provider `dispose` | trigger serviceShutdown/update, mode drain → disposed; 2 s |
| provider → service `cli/request` | parentRequestId, owner, binding; только account/login/start (external auth), account/read, account/rateLimits/read; ≤parent deadline, максимум 70 s |
| provider → service `cli/reconnect` | parentRequestId + idle grant: confirmed exit → new appServerGeneration → login; ≤prepare budget 90 s |
| service → provider event `lease/grant` | service — единственный owner/issuer account, idle и дочерних turn grants |
| service → provider event `lease/revoke` | exact grant invalidation; disconnect/timeout не terminal |
| service → provider event `turnStarted` | taskId/runId/turnId/turnLeaseId; service резервирует lease **до** dispatch; event подтверждает CLI start |
| service → provider event `turnTerminal` | те же IDs + confirmed terminal/CLI exit; освобождает exact lease; при отсутствии active/compaction/dispatching/uncertain service будит общий probe |
| provider → service event `connectionChanged` | новая provider/credential lineage → visible connection_changed, без silent send |

`answerDecision` — action configureByClient, отдельного RPC нет. Stage-1 MCP всегда `interactiveClientAvailable:false`, включая probes, даже при открытом окне: needsDecision headless запрещён. Probe не создаёт turn lease/не отправляет input; возвращает общий `limitsSnapshotId`/`checkRevision`; admit заново проверяет допуск. Idle grant несовместим с active/compaction/dispatching/uncertain, удерживается всю idle mutation. Refresh не ждёт admission mutex.

Outcome kinds (закрытый enum `kind`): `authenticated`, `cliResponse`, `ready`, `waitUntil`, `needsDecision`, `unavailable`, `cancelled`, `configured`, `pending`, `succeeded`, `failed`, `uncertain`, `disposed`. Hello/status — собственные envelopes. ready: accountRevision/authGrantId/limitsSnapshotId/validUntil; waitUntil: waitId/resetAt/reason; unavailable: code/retryable/retryAfterMs/messageKey; needsDecision: decisionId/reason/options(wait,useRemaining,cancel)/resetAt. Общий enum `reason` для provider outcomes/waitingLimit: `low_remaining`, `exhausted`, `limits_unknown`, `reset_unknown`, `active_turns`, `action_required`, `connection_changed`. Lifecycle/cancel metadata — `trigger`, не расширяет reason.

Unavailable codes (закрытый enum): `LIMITS_UNKNOWN`, `RESET_UNKNOWN`, `BUSY_ACTIVE`, `AUTH_REQUIRED`, `AUTH_REVOKED`, `STORE_UNAVAILABLE`, `CLIENT_REQUIRED`, `PLATFORM_UNSUPPORTED`, `PROVIDER_PROCESS_UNCERTAIN`, `MIRROR_BUSY`. Protocol errors отдельно: STALE_FENCE, INVALID_REVISION_STEP, METHOD_NOT_SUPPORTED; provider-specific diagnostic остаётся внутри provider.

### Fence mapping

| Service / прежнее имя | Provider fence field / проверка |
| --- | --- |
| generation | serviceGeneration; service IPC сохраняет generation |
| effective config revision | configRevision; global scope |
| child instance | providerGeneration; global scope |
| serverInstance | binding.appServerId + binding.appServerGeneration |
| connectionRevision | binding.accountRevision + binding.leaseId + binding.leaseRevision; identity/grant, не settings CAS |
| admission preference | admission.selectionRevision; только prepare/admission, не active refresh |
| task-run | taskId + runId + turnId + turnLeaseId; execution callbacks, не wait fence |
| durable wait identity | waitId; **единственный wait fence** cancel/wake; taskId/spaceId routing, taskRevision не rejection criterion |

Global fields обязательны всегда; binding — auth/refresh/prepare/CLI operations, admission — только prepare. Initial authenticate получает service provisional binding. Result эхо-возвращает исходный fence; проверки до side effect/после await. effectiveBinding разрешён только по записанным service grants той же idle parent transaction. New accountRevision строго current+1; повтор login текущего epoch возвращает current. Stale → STALE_FENCE, неверный шаг → INVALID_REVISION_STEP. WaitId не переиспользуется; clarification меняет task revision, **не** wait identity. Recovery перевыпускает global envelope, сохраняет waitId; old child callbacks отсекаются global fence.

### Provider outcome → task state / wake waiters

| Outcome | Task state / reason | Будит wait_task / wait_tasks |
| --- | --- | --- |
| ready (admit) | queued → running после confirmed start | Нет |
| ready (probe) | fresh admit для живых waitId | Нет |
| waitUntil | waiting_limit / low_remaining или exhausted | Нет; checkpoint timedOut:true |
| unavailable LIMITS_UNKNOWN / RESET_UNKNOWN | waiting_limit(resetAt:null) / limits_unknown или reset_unknown | Нет; общий poller |
| unavailable BUSY_ACTIVE | waiting_limit(resetAt:null) / active_turns | Нет; idle turnTerminal запускает probe, не ждать resetAt |
| unavailable AUTH_REQUIRED / AUTH_REVOKED | error / action_required | Да: «Provider sign-in required. Open connection settings and reconnect.» |
| unavailable STORE_UNAVAILABLE / CLIENT_REQUIRED | error / action_required | Да: «Open the installed companion connection settings to restore provider access.» |
| unavailable PLATFORM_UNSUPPORTED | error / action_required | Да: «This provider does not support this platform. Select a supported provider.» |
| unavailable PROVIDER_PROCESS_UNCERTAIN | error / action_required | Да: «Provider process ownership is uncertain. Run verified service recovery before retrying.» |
| unavailable MIRROR_BUSY | error / action_required | Да: «Provider configuration is busy. Open connection settings and run repairMirror after owner verification.» |
| connectionChanged event | error / connection_changed | Да: «Connection changed. Confirm the selected connection before continuing.» |
| needsDecision | waiting_approval, provider decisionId | Да; только interactive client; headless — protocol error/provider_unavailable |
| authenticated / cliResponse / configured / pending / succeeded / failed / uncertain / disposed / cancelled | lifecycle/config/wait acknowledgement, не task terminal | Нет сами по себе; cancel_task → cancelled будит после durable cancellation |

error сохраняет chat/draft/queued inputs, code/message/reason/recoveryRequired; wait_task возвращает их Claude, wait_tasks включает в settled. До dispatch recoveryRequired:false; potentially live turn → true, lease остаётся до terminal/confirmed exit. После настройки только явный continue_task разрешает fresh admission, без auto replay. Вход в action_required увеличивает revision для afterRevision.

Provider config: единственный путь `<userConfig>/rundix-service/provider.json` (Windows `%APPDATA%/Rundix/rundix-service/provider.json`, macOS `~/Library/Application Support/Rundix/rundix-service/provider.json`), схема **ProviderConfigV1**. Не settings.json/workspace/env. ≤16 KiB, unknown/duplicate fields отвергаются, revisions safe integer; entry absolute verified local .cjs, user-only ACL/0700+0600, no symlink escape. Digest — согласованность, не same-user защита.

```json
{"schemaVersion":1,"configRevision":7,"provider":{"id":"<provider-id>","protocolMajor":2,"version":"<provider-version>","entryPath":"<absolute-versioned-install-dir>/provider-entry.cjs","manifestSha256":"<manifest-digest>"}}
```

## 10. Failure matrix

**Решение D38 — нормативные отказы.** Отсутствие ACK не равно отсутствию send, auto replay ambiguous input запрещён.

| Failure | Нормативное recovery |
| --- | --- |
| Service/CLI crash | Next-client pid/startTime + thread/watermark checks; live turn observe/interrupt. Неясная доставка → delivery_unknown/no resend. Confirmed death освобождает slot; no-chat pre-send → error notSent. |
| Adapter/window close/reload | Отписка клиента, task продолжает; reconnect IDs/full snapshot. Draft/requestId до ACK. Two windows approvals → один send; reload только target. |
| Concurrent start/auth_failed | Fixed listener winner, starting publication; reread discovery/ping/hello в startup budget, macOS unlink под guard. |
| Hung/PID reuse | Explicit verified D14 recovery; mismatch → owner_unverified, не kill по timeout. |
| OS reboot | Нет autostart; next-client fresh checks, old dispatch не replay. |
| Provider loss | No fallback/active binding switch; history/recovery доступны, новые sends закрыты; §9 visible errors. |
| Missing directory/storage | Release по stored key после terminal/cancel. До send storage failure запрещает dispatch, damaged record не пустая history; draft/backup + storage_unavailable. |

## 11. Проверки и финишная черта

**Решение D39 — будущие проверки.** Сейчас только Markdown/JSON/source static checks, без runtime/live/package. Будущие tests synthetic; реальные sign-in не менять, Actions выключены.

| Future acceptance | Проверка |
| --- | --- |
| Headless | Fake service/provider/stdio: ACK-before-send, dedup, typed pre/mid-turn exhaustion, continuation once then FIFO, unknown shared poller, waitId cancel race, all action_required codes wake wait_task. |
| Space/trust | Foreign IDs/space-filtered snapshots/cursors/presence; Windows case/junction/gitdir/commondir/non-git/env; untrusted zero metadata. Two spaces/two windows/reload isolation. |
| UI/history | Service owner/chatId continuation/drafts/full resubscribe/huge-item/slow subscriber; RU/EN, both themes, narrow/wide. |
| Recovery/legacy | Crash before/after chatId/intent/dispatch/ACK/history item; no duplicate/slot leak. Concurrent startup/auth_failed/HMAC replay/hung PID reuse. Migration marker/move/backup, idle-exit then old installLauncher cannot touch new launcher, mandatory MCP entry replacement. |
| CLI/package | Normal-home external-auth no-overwrite Q3; user integrations/task overrides. Local npm test/browser, host mcp-host.cjs + future two-window harness, package ZIP/source/IDs/icons/launcher audit. Windows/macOS smoke with synthetic profiles; live only separately authorized. |

**Решение D40 — review evidence.** Логи фиксируют design fixes, не approval этой редакции. REVIEW.md: максимум три раунда; runtime acceptance после реализации.

## 12. Later hardening

**Решение H01 — later hardening.** Отложены native locks/pipe DACL/peer UID/Job Objects/handle identity, NTFS/macOS alias guarantees, manual/MCP directory arbiter (D05), immutable storage/replay/chunking/HMAC cursors, active-version handover, multi-binding app-servers/auto-rollback/relocation. Отдельный future design при доказанной потребности.

## 13. Открытые вопросы

**Q1 — закрыт (дизайн).** Interface/fences/outcomes согласованы §9; mid-turn source = typed CLI error + prepareTurn(mode:probe), D24. Это не runtime verification.

**Открытый вопрос Q2 — launcher/platform smoke.** Какой installed absolute Node/minimum version поддержать после закрытия VS Code, и какой restart MCP доступен целевой Claude версии? Проверить fixed pipe EADDRINUSE, stale unix guard, OS processStart, legacy error-only endpoint в isolated environment; это не уже пройденные проверки.

**Открытый вопрос Q3 — CLI external-auth persistence.** Документация подтверждает external mode, но не доказывает no-overwrite для pinned CLI. Проверить source и synthetic normal CODEX_HOME: sentinel sign-in bytes/metadata неизменны до/после login/refresh/reconnect/crash/restart, отдельный CLI account/read сохраняет synthetic sign-in без inference. Реальные auth-файлы не читать/не менять. Проверить user config/skills/MCP/history и task overrides; release gate.

## 14. Review log

Gemini #1–11 / Sonnet #1–12: D04–D35; launcher уточнён D31.

### Review log round 2

| Item | Итог final alignment (дизайн, static) |
| --- | --- |
| 1 | Outcome→state/wake table; action_required виден Claude; headless false; общий reason enum. |
| 2 | Единый method/event list, probe, turn lifecycle, service-owned leases/capabilities. |
| 3 | Typed CLI limit error + probe resetAt; public Q1 закрыт. |
| 4 | Fence mapping; cancel/wake только waitId, taskRevision informational. |
| 5 | BUSY_ACTIVE → active_turns; idle turnTerminal будит probe. |
| 6 | Service poller 1→2→4→8→15 min; retryAfterMs lower bound; tick ≤30 s. |
| 7 | Fixed continuation первым, затем clarification FIFO. |
| 8 | Один provider.json / ProviderConfigV1; settings.json только MCP defaults. |
| 9 | Main installLauncher/serve paths проверены; новый launcher вне old bin, replacement MCP entry обязателен. |
| 10 | Ping → nonce/HMAC hello; reread/retry auth_failed в startup budget. |
| 11 | MIRROR_BUSY будит wait_task; repairMirror после owner verification. |
| 12 | Owner 2026-10-20: normal CODEX_HOME; hard gate + required no-overwrite test; pinned CLI evidence открыт. |
| 13 | Authenticate для catalog без admission; hung-owner recovery message; connectionChanged виден Claude. |
