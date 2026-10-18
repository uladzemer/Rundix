# Rundix

**English** · [Русский](#русский)

An independent VS Code interface for the official Codex CLI through App Server. This edition uses the CLI's current local sign-in. Rundix never reads or copies credential files and never asks App Server to return raw authentication tokens.

## Features

- Native editor tabs, session history, groups, bookmarks and conversation branches.
- Markdown, highlighted code, file changes and incremental response streaming.
- Image paste and attachments, project files and optional IDE context.
- Follow-up queue, editing, reordering, steering and sending an unrelated queued task in a new tab.
- Blocking and asynchronous questions, model and reasoning selection, access modes and supported Fast service tiers.
- Current account and official usage snapshots reported by the CLI. A quota error does not turn into zero remaining usage.
- Managed official CLI installation and updates, or a user-selected CLI executable.
- Russian and English interface, VS Code theme colors and reduced-motion support.
- Optional completion sounds, locally selected Stop hooks and user-configured Telegram notifications. Telegram is off until configured; enabling it sends the final answer to the chosen chat. Hook scripts run with the user's permissions.
- Experimental task preparation with a separate explicit approval before execution.

## Sign in and start

1. Install the VSIX in VS Code.
2. Run **Rundix: New tab**.
3. Rundix asks the CLI for the current account. An existing CLI sign-in is reused automatically. If needed, open `/account` and choose **Sign in through browser** to start the official CLI browser flow, or run `codex login` in your terminal.
4. Select a model and send a message.

The extension inherits the CLI's environment, including `CODEX_HOME` when explicitly set. Credential storage, refresh and support for operating-system credential stores belong to the installed CLI. Account changes made outside the extension can be picked up with **Refresh status**. The extension maintains its own conversations metadata and drafts, without storing account credentials.

## Settings and development identity

Settings appear under **Rundix**, with the `rundix` prefix: language, chat width, context style, motion, CLI path, update channel and history scope. The development extension ID is `local-rundix-tools.rundix`; this is a separate installation and storage namespace. A Marketplace publisher has not been configured.

From the repository root, run `npm.cmd run setup`, `npm.cmd test`, `npm.cmd run test:browser` and `npm.cmd run package`. For Extension Host authentication checks, run `powershell -NoProfile -File test/host.ps1 -TestFile local-auth-host.cjs` from this directory. That test uses a synthetic App Server and does not inspect or alter the user's real sign-in.

## Licenses

Project code, the `{R}` mark and the action SVGs are MIT licensed. Included library licenses are in `THIRD_PARTY_NOTICES.txt`. Icon provenance is in `resources/icons/NOTICE.md`. Rundix is not an official OpenAI product. Model availability, quotas and CLI functionality depend on the user's account and the installed official CLI.

## Русский

Rundix — самостоятельный интерфейс VS Code для официального Codex CLI. Расширение использует текущий локальный вход CLI: авторизация, обновление учётных данных и системное хранилище входа остаются ответственностью CLI. Rundix не читает и не копирует файлы авторизации и не запрашивает сырые токены.

Создайте вкладку командой **Rundix: Новая вкладка**. Если вход уже выполнен в CLI, он используется автоматически. Если входа нет, откройте `/account` → **Войти через браузер** либо выполните `codex login` в терминале. После внешней смены входа нажмите **Обновить статус**. Выберите модель и отправьте запрос.

Доступны история, группы, закладки и ветки чатов, Markdown и код, изображения и контекст проекта, очередь уточнений, вопросы, режимы доступа, модели, глубина рассуждения и официальные лимиты. Работают управляемые обновления CLI, русский и английский интерфейс, темы VS Code и настройка уменьшения анимации.

Необязательные уведомления Telegram отправляют итоговый ответ в выбранный чат только после настройки. Пользовательские Stop-скрипты выполняются с правами пользователя. Звук, настройки и черновики хранятся отдельно от авторизации CLI.

Это отдельная установка `local-rundix-tools.rundix` с настройками `rundix`. Подготовка пакета не означает публикацию в Marketplace. Код и собственные значки распространяются по MIT; уведомления о библиотеках находятся в `THIRD_PARTY_NOTICES.txt`.
