# Rundix

**English** · [Русский](#русский)

Work with the official Codex CLI in VS Code. Keep conversations in editor tabs, attach images and project files, and queue follow-ups while a task is running.

Rundix is an independent extension, not an official OpenAI product.

## Features

- **Organize conversations:** native editor tabs, history, groups, bookmarks and conversation branches.
- **Work with code:** streaming responses, Markdown, syntax highlighting and file changes.
- **Add context:** paste images, attach files and include selected code or IDE context.
- **Keep tasks moving:** edit and reorder queued follow-ups, steer a running task or send a queued task to a new tab.
- **Control each task:** choose a model, reasoning effort, access mode and Fast tier when supported by the CLI and account.
- **Stay informed:** answer questions in chat and check account usage limits.
- **Make it yours:** English and Russian UI, VS Code theme colors, chat width and motion settings.

Rundix can install and update the official CLI, or use an executable you choose in settings.

## Get started

1. Install **Rundix** from the VS Code Extensions view.
2. Open the Command Palette and run **Rundix: New tab**.
3. If you already use Codex CLI, Rundix reuses its current sign-in. Otherwise, open `/account` → **Sign in through browser**, or run `codex login` in a terminal.
4. Choose a model and send your first message.

The CLI manages local sign-in and credential storage. Rundix does not read or copy credential files. Available models, Fast tiers and usage limits depend on your account and CLI version. After changing sign-in outside Rundix, use **Refresh status** in the account menu.

## Settings and optional features

Find **Rundix** in VS Code Settings to change the language, chat width, context indicator, motion, CLI path, update channel and history scope.

Completion sounds, Telegram notifications and local Stop scripts are optional. Telegram is off until configured; when enabled, it sends the final answer to the chat you select. Stop scripts run with your user permissions. Experimental task preparation asks for explicit approval before execution.

Compatible companion extensions can add another connection. Select one through `/account` → **Connection settings**. If the selected companion is unavailable, Rundix preserves your draft and reports the error before sending.

## Русский

Работайте с официальным Codex CLI прямо в VS Code. Открывайте чаты в отдельных вкладках редактора, добавляйте изображения и файлы проекта, ставьте уточнения в очередь во время выполнения задачи.

Rundix — независимое расширение, не официальный продукт OpenAI.

### Возможности

- **Порядок в чатах:** вкладки редактора, история, группы, закладки и ветки разговоров.
- **Работа с кодом:** потоковые ответы, Markdown, подсветка синтаксиса и просмотр изменений файлов.
- **Контекст задачи:** вставка изображений, вложения, выделенный код и контекст IDE.
- **Очередь уточнений:** редактирование и перестановка задач, уточнения во время выполнения и отправка задачи в новую вкладку.
- **Управление задачей:** выбор модели, глубины рассуждения, режима доступа и Fast при поддержке CLI и аккаунтом.
- **Вопросы и лимиты:** ответы на вопросы прямо в чате и просмотр доступных квот.
- **Настройка интерфейса:** русский и английский языки, цвета темы VS Code, ширина чата и анимация.

Rundix может установить и обновлять официальный CLI или использовать исполняемый файл, выбранный в настройках.

### Начало работы

1. Установите **Rundix** из раздела расширений VS Code.
2. Откройте палитру команд и выполните **Rundix: Новая вкладка**.
3. Если вы уже вошли в Codex CLI, Rundix использует текущий вход. Иначе откройте `/account` → **Войти через браузер** или выполните `codex login` в терминале.
4. Выберите модель и отправьте первое сообщение.

Входом и хранением учётных данных управляет CLI. Rundix не читает и не копирует файлы авторизации. Доступные модели, Fast и лимиты зависят от аккаунта и версии CLI. После внешней смены входа нажмите **Обновить статус** в меню аккаунта.

### Настройки и дополнительные возможности

В настройках VS Code найдите **Rundix**: там доступны язык, ширина чата, индикатор контекста, анимация, путь к CLI, канал обновлений и область истории.

Звуки завершения, Telegram и локальные Stop-скрипты включаются по желанию. Telegram выключен до настройки; после включения он отправляет итоговый ответ в выбранный чат. Stop-скрипты выполняются с вашими правами. Экспериментальная подготовка задачи запрашивает явное согласование перед выполнением.

Совместимый дополнительный модуль может предоставить другой способ подключения. Выберите его через `/account` → **Настройки подключения**. Если выбранный модуль недоступен, Rundix сохранит черновик и сообщит об ошибке до отправки.

---

License / Лицензия: [MIT](https://github.com/uladzemer/Rundix/blob/main/LICENSE). Third-party notices / Лицензии библиотек: [THIRD_PARTY_NOTICES.txt](https://github.com/uladzemer/Rundix/blob/main/standalone/THIRD_PARTY_NOTICES.txt).
