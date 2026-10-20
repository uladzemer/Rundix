# Изоляция тестов и production-граница — 20 октября 2026

## Что было задано

Устранить доступ service-тестов к настоящим пользовательским каталогам и endpoint. Затем закрыть уязвимость первого исправления: project env мог задавать RUNDIX_SERVICE_ROOT / RUNDIX_PROVIDER_CONFIG_DIR / RUNDIX_SERVICE_ENDPOINT_NAMESPACE поставляемому adapter и перенаправлять provider/service. Сохранить guard, повторить npm/host/package и сделать локальный коммит без push.

## Что я решил

### Первоначальная утечка тестов

Найден небезопасный путь `test/service-mode-host.cjs` → `test/host.ps1`: service mode включался без изоляции процесса, а тест подменял только launcher. `extension.cjs:syncServiceSettings` при отсутствии installation после Stop/reload вызывал `locations()` без root. Значения синтетических настроек совпадают с описанными владельцем. Исторический порядок создания удалённых артефактов не восстанавливался; небезопасный прогон с реальными путями не повторялся. Другие service-тесты используют временные root/configPath и не подтвердились как самостоятельные источники записи в настоящий root.

### Исправленная граница безопасности

Первое исправление ошибочно разрешило RUNDIX_* overrides в production. Это исправлено удалением механизма из runtime, без переключаемого env-маркера:

- `runtime/service-paths.cjs` — единый production resolver. Не содержит чтения RUNDIX_*, pathEnv или загрузчика тестового helper. Обычные production defaults и явно переданные программой root сохраняются. Endpoint namespace из окружения невозможен.
- `runtime/service-environment.cjs` — allowlist не пропускает ни одной переменной RUNDIX_*, включая неизвестные имена и другой регистр; это относится к service/provider/CLI spawn.
- `test/test-isolation.cjs` — только явно запущенный source-tree helper подменяет экспорт source-tree resolver в своём процессе. Он не изменяет файлы runtime. Ни VSIX, ни установленная service-копия helper не содержат и не импортируют. Уникальный временный root сам изолирует endpoint; env namespace больше не используется runtime.
- `test/prepare-host.cjs`, `test/host.ps1` — временная development extension включает helper перед активацией исходного расширения. Временный manifest отключает startup activation; тесты явно активируют расширение после установки mock. createRequire привязан к уже загруженному тестовому entry, чтобы Windows-регистр пути не создавал вторые экземпляры модулей. Поставляемый manifest не меняется.
- `runtime/service-launcher.cjs:installLauncherAsync` и `runtime/service-provider-config.cjs:readProviderConfigAsync` разрешают root/configPath в вызывающем потоке до запуска worker. Тестовая подмена остаётся только в source-процессе; worker получает явный временный путь.
- `test/production-service-contract.cjs`, `test/service-isolation.cjs` — исполняют исходный production resolver и установленную копию в изолированном контексте со враждебным env. Любое чтение RUNDIX_* вызывает ошибку; ожидаются стандартные synthetic-пути и пустой namespace. Проверяются также фильтрация всего префикса и оба worker-перехода.
- `test/package-audit.cjs` — применяет тот же контракт к исходникам, извлечённым из фактического ZIP. Запрещает override-reader/test loader в shipped service-paths; проверяет shipped serviceEnvironment с враждебным env. Тестовые файлы исключены из VSIX.

Аудит вызывающих путей: extension launcher/settings fallback → locations → servicePaths; endpoint start/connect/probe/recover; launcher и installation worker; service-main migration/headless host; service-connection demand-start; adapter legacy registration и mcp-server --service; configLocation/readProviderConfig и повторная digest-проверка service-provider. Все production-вызовы используют resolver без RUNDIX overrides. Installed launcher передаёт собственный root явно.

### Guard сохранён

`test/test-isolation.cjs` использует только readdir/lstat: mtime/ctime/birthtime, размер, mode, inode. Содержимое пользовательских файлов не читается; имена snapshot хешируются; symlink/junction не обходятся. Проверяется весь настоящий LOCALAPPDATA/Rundix, включая service/providers, и APPDATA/Rundix. Существующие provider-файлы допустимы; изменения дают ошибку. npm runner проверяет после каждого файла и всего набора; внешний host runner — после завершения Code. Пользовательские каталоги не удаляются и не исправляются.

### Проверки текущего исправления

- `npm.cmd test`: 54 тестовых файла — PASS; guard после каждого и всего набора — PASS.
- Отдельные service-isolation / service-adapter / service-e2e — PASS. После добавления worker-регрессий service-isolation повторён — PASS.
- `host.ps1 -TestFile mcp-host.cjs`, `startup-host.cjs`, `local-auth-host.cjs`, `service-mode-host.cjs`, `host.cjs`: все PASS на финальном harness; каждый metadata guard — PASS.
- `npm.cmd run package`: PASS, фактический VSIX — 137 разрешённых файлов. Новый hostile-env контракт shipped resolver/allowlist — PASS. Identity, README, icons и исключение тестов проверены существующим ZIP-аудитом. Пакет не устанавливался и не публиковался.
- `git diff --check`: PASS.
- Независимое read-only ревью по REVIEW.md, два раунда, второй только затронутые исправления: 0 подтверждённых замечаний. Отмеченная возможность потерять source-подмену на worker-переходе закрыта разрешением configPath в caller и regression-тестом.
- Уровень проверки: статическая и синтетическая Windows/Extension Host. Настоящие аккаунты, inference и пользовательский sign-in не использовались.

Промежуточные host-прогоны обнаружили несовпадение module cache из-за регистра Windows-пути. Исправлено привязкой require к тестовому entry; затем все пять host-тестов прошли. Guard оставался успешным и при этих сбоях.

## Что не удалось

Блокеров и оставшихся подтверждённых дефектов нет. Проверки выполнены на Windows. Before/after guard сравнивает состояние, а не непрерывную историю; конкурентная запись владельца в наблюдаемые каталоги также даст ошибку. Упаковщик выводит существующее предупреждение Node DEP0190 о shell в package.cjs; сборка и аудит успешны.

## Что бы я ещё сделал

- 🔴 Опционально: добавить интеграционный сценарий hostile project env с заведомо ложным provider/service без обращения к настоящим данным.
- 🟡 Опционально: проверить source isolation и Unix sockets на Linux/macOS.
- 🟢 Опционально: сохранять машинный итог guard без пользовательских имён и путей.
