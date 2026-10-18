# Rundix

![Rundix — curly braces enclosing R](standalone/resources/extension-icon.png)

A VS Code interface for the official Codex CLI. Conversations live in native editor tabs, with Markdown responses, images, queued follow-ups, project context, questions and usage information.

This edition uses only the Codex CLI sign-in on the current computer. The CLI owns authentication and credential storage; Rundix does not read, copy or manage credential files. If sign-in is missing, the account menu can start the official browser sign-in through the CLI.

Rundix is an independent project and is not an official OpenAI product.

## Screenshots

The actual Rundix webview, captured in a browser with synthetic demonstration content. These are UI examples, not a live model run or a capture of a user's conversation. Native VS Code editor tabs are outside the captured webview area.

Chat, highlighted code and the message composer:

![Rundix chat with a TypeScript example in the dark theme](standalone/docs/screenshots/chat-dark.jpg)

Access modes and reasoning effort:

![Rundix access-mode menu and reasoning controls](standalone/docs/screenshots/access-modes.jpg)

## Develop

The extension source is in [`standalone/`](standalone/README.md).

```powershell
npm.cmd run setup
npm.cmd test
npm.cmd run test:browser
npm.cmd run package
```

The package is written to `standalone/rundix-<version>.vsix`. Browser checks need Chrome; set `CHROME_PATH` if it is not installed in a standard location. Extension Host checks run in an isolated VS Code profile. Synthetic checks do not send model requests.

The development extension ID is `local-rundix-tools.rundix`. Its commands, settings and storage are separate from other editions. No Marketplace release or verified publisher namespace is configured yet.

## Русский

Rundix — интерфейс для официального Codex CLI в VS Code: отдельные вкладки чатов, Markdown, изображения, очередь уточнений, контекст проекта, вопросы и лимиты.

Используется только текущая авторизация Codex CLI на компьютере. Учётными данными и их хранением управляет CLI. Расширение не читает и не копирует файлы авторизации. Если вход отсутствует, меню аккаунта позволяет открыть официальный вход через браузер.

Подробности: [`standalone/README.md`](standalone/README.md). Лицензия кода и собственных значков — [MIT](LICENSE); лицензии включённых библиотек собраны в `standalone/THIRD_PARTY_NOTICES.txt`.
