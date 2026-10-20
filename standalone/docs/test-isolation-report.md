# Изоляция service-тестов — 20 октября 2026

## Что было задано

Исключить доступ тестов к настоящим service/provider-каталогам и endpoint, добавить metadata guard, выполнить локальные проверки и коммит без push.

## Что я решил

Подтверждён небезопасный путь: `test/service-mode-host.cjs` через `test/host.ps1`. Harness запускал Extension Host в service mode без overrides процесса; тест подменял только launcher. Это не покрывало `extension.cjs:syncServiceSettings`: после Stop/reload installation отсутствует, обработчик настроек вызывает `locations()` без root. Подмена также не защищала вызовы вне срока её действия. Синтетические настройки из сообщения владельца совпадают со значениями этого теста. Исторический порядок создания удалённых файлов восстановить нельзя; небезопасный прогон с настоящими путями не повторялся.

Другие service-тесты не подтвердились как самостоятельные источники записи в настоящий root: рабочие вызовы уже передавали временные root/configPath. Проверки стандартного layout в `service-adapter`, `service-ipc`, `service-provider-config` используют синтетические home/SID/platform и не записывают по стандартным путям. Теперь все тесты имеют общую защиту, включая прямые запуски.

Аудит путей разрешения:

- `runtime/service-paths.cjs:servicePaths` — единый resolver service root и provider config. Явный root имеет приоритет над `RUNDIX_SERVICE_ROOT`; `RUNDIX_PROVIDER_CONFIG_DIR` задаёт каталог с provider.json; `RUNDIX_SERVICE_ENDPOINT_NAMESPACE` изолирует endpoint даже при явно переданном root.
- `runtime/service-endpoint.cjs:locations` — endpoint/discovery для start/connect/probe/recover.
- `runtime/service-launcher.cjs:installLauncher` и worker `installLauncherAsync` — установка runtime/shim через locations.
- `runtime/service-main.cjs:runService` — endpoint, migration, headless host получают разрешённый root; CLI поддерживает --service-root.
- `runtime/service-connection.cjs:createServiceConnection` — discovery, registration, demand-start ребёнка с явным --service-root.
- `runtime/service-adapter.cjs` — legacy registration и service connection; `runtime/mcp-server.cjs --service` передаёт root adapter.
- `extension.cjs` — launcher без root, service window connection, fallback syncServiceSettings.
- `runtime/service-provider-config.cjs:configLocation/readProviderConfig` — стандартный provider config; `runtime/service-provider.cjs` использует configLocation также при повторной проверке digest. Явный configPath сохраняет приоритет.
- `runtime/service-environment.cjs` сохраняет три overrides в дочерних процессах. Параметр resolver pathEnv отделён от adapter env, который относится к binding MCP-клиента.

Guard и изменённые файлы:

- Новые `test/test-isolation.cjs`, `test/preload-isolation.cjs`, `test/run-isolated.cjs`; обновлены `test/host.ps1`, `package.json`. npm-набор проверяет реальные каталоги после каждого файла и всего запуска. Host guard включается до запуска Code. Устаревший host-report удаляется до проверки.
- Guard использует readdir/lstat: mtime/ctime/birthtime, размер, mode, inode. Содержимое файлов не открывается; имена snapshot хешируются; symlink/junction не обходятся. Проверяется весь настоящий LOCALAPPDATA/Rundix, включая service и providers, и APPDATA/Rundix. Существующие provider-файлы допустимы, изменения дают ошибку. Пользовательские каталоги не удаляются и не исправляются.
- Обновлены все исполняемые `test/service-*.cjs`, включая service-mode-host и service-chat-browser. Два service-*-fixture.cjs — библиотеки. Новый `test/service-isolation.cjs` проверяет guard и overrides. В service-mode-host добавлена регрессия settings fallback после Stop/reload без installation.
- Runtime: новый `runtime/service-paths.cjs`; обновлены `service-endpoint.cjs`, `service-provider-config.cjs`, `service-environment.cjs`.
- `.vscodeignore`, `test/package-audit.cjs` включают новый runtime-модуль. Этот отчёт: `docs/test-isolation-report.md`.

Проверки:

- `npm.cmd test`: 54 тестовых файла — PASS. Реальный guard после каждого файла и всего запуска — PASS.
- Отдельный повтор `service-isolation.cjs` после расширения регрессии — PASS: default layout, overrides, namespace, filtered child environment, launcher без root, отсутствие provider в isolated config. Guard обнаруживает создание/изменение/удаление синтетических объектов и не следует junction.
- `host.ps1 -TestFile mcp-host.cjs`, `startup-host.cjs`, `local-auth-host.cjs`, `service-mode-host.cjs`, `host.cjs`: все PASS, каждый с внешним guard — PASS. Повтор service-mode-host подтвердил fallback без installation; повтор mcp-host после исправления resolver — PASS.
- `node test/service-chat-browser.cjs`: PASS, RU/EN × light/dark × 320/900; guard — PASS.
- `npm.cmd run package`: PASS; фактический VSIX прошёл аудит: 137 разрешённых файлов, новый runtime включён, тесты исключены, identity/README/icons проверены аудитом. Пакет не устанавливался и не публиковался.
- `git diff --check`: PASS.
- Независимое read-only ревью по REVIEW.md, два раунда, второй только исправления и затронутые пути: 0 подтверждённых замечаний. Проверка статическая и синтетическая Windows/Extension Host, без настоящего CLI, аккаунтов и inference.

Первый npm-прогон выявил конфликт нового параметра env с adapter binding environment. Исправлено разделением pathEnv; затем adapter и полный npm-набор прошли. Ни первый, ни итоговые прогоны не изменили настоящие каталоги по данным guard.

## Что не удалось

Блокеров и оставшихся подтверждённых дефектов нет. Исторический порядок создания удалённых артефактов не восстановлен. Проверки выполнялись на Windows. Before/after guard сравнивает состояние, а не непрерывную историю; конкурентные изменения владельцем также вызовут ошибку, поскольку guard не определяет автора записи. Упаковщик вывел существующее предупреждение Node DEP0190 о shell в package.cjs; сборка и аудит успешны.

## Что бы я ещё сделал

- 🔴 Опционально: добавить непрерывное наблюдение для кратковременных записей между snapshots.
- 🟡 Опционально: выполнить тот же набор на Linux/macOS для Unix socket isolation.
- 🟢 Опционально: сохранять машинный итог guard без имён и пользовательских путей.
