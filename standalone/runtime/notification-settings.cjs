const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const locale = require('../ui/i18n.js');
const { readTelegramEnv } = require('./completion-notifications.cjs');
const sounds = require('./notification-sounds.cjs');

const text = (ru, en) => locale.language === 'ru' ? ru : en;

class NotificationSettings {
  constructor(vscode, notifications) { this.vscode = vscode;this.notifications = notifications;this.open = false; }
  async configure() {
    if (this.open) return;
    this.open = true;
    try {
      while (true) {
        const config = this.notifications.getSettings();
        const ready = await this.notifications.hasTelegram();
        const choice = await this.vscode.window.showQuickPick([
          { id: 'telegram', label: 'Telegram', description: text(config.telegram ? 'Включён: итог ответа' : 'Выключен', config.telegram ? 'On: final answer' : 'Off') },
          { id: 'import', label: text('Импортировать Telegram из Claude', 'Import Telegram from Claude'), description: text('Токен и получатель → защищённое хранилище VS Code', 'Token and recipient → VS Code SecretStorage') },
          { id: 'manual', label: text('Настроить Telegram вручную', 'Set up Telegram manually') },
          { id: 'sound', label: text('Звук завершения', 'Completion sound'), description: config.sound === 'system' ? text('Системный', 'System default') : config.sound ? path.basename(config.sound) : text('Выключен', 'Off') },
          { id: 'attach', label: text('Прикрепить хук завершения…', 'Attach a completion hook…'), description: text('JS / CJS / PowerShell; выполняется с правами пользователя', 'JS / CJS / PowerShell; runs with your user permissions') },
          ...(config.hooks.length ? [{ id: 'remove', label: text('Открепить хук…', 'Detach a hook…'), description: String(config.hooks.length) }] : []),
          ...(ready ? [{ id: 'test', label: text('Отправить тест в Telegram', 'Send a test to Telegram') },
            { id: 'forget', label: text('Удалить подключение Telegram', 'Remove Telegram connection') }] : []),
          ...(config.sound ? [{ id: 'preview', label: text('Прослушать выбранный звук', 'Preview selected sound') }] : []),
        ], { title: text('Rundix — уведомления и хуки', 'Rundix — notifications and hooks'), ignoreFocusOut: true });
        if (!choice) return;
        if (choice.id === 'telegram') {
          if (!ready) { await this.manual();continue; }
          await this.notifications.setSettings({ ...config, telegram: !config.telegram });
        } else if (choice.id === 'import') await this.importTelegram();
        else if (choice.id === 'manual') await this.manual();
        else if (choice.id === 'sound') await this.sound();
        else if (choice.id === 'attach') await this.attach();
        else if (choice.id === 'remove') {
          const hook = await this.vscode.window.showQuickPick(config.hooks.map(file => ({ label: path.basename(file), description: file, file })), { title: text('Открепить хук', 'Detach a hook') });
          if (hook) await this.notifications.setSettings({ ...config, hooks: config.hooks.filter(file => file !== hook.file) });
        } else if (choice.id === 'forget') {
          await this.notifications.setSettings({ ...config, telegram: false });await this.notifications.clearTelegram();
        } else if (choice.id === 'preview') await this.notifications.playSound(config.sound);
        else if (choice.id === 'test') {
          await this.notifications.telegram({ text: text('Проверка: уведомления о завершении подключены.', 'Test: completion notifications are connected.'), cwd: '' });
          void this.vscode.window.showInformationMessage(text('Тестовое сообщение отправлено.', 'Test message sent.'));
        }
      }
    } catch {
      void this.vscode.window.showErrorMessage(text('Не удалось настроить уведомление. Проверь файл, подключение Telegram или выбранный звук.', 'Could not configure the notification. Check the file, Telegram connection or selected sound.'));
    } finally { this.open = false; }
  }
  async importTelegram() {
    const files = await this.vscode.window.showOpenDialog({ canSelectMany: false,
      defaultUri: this.vscode.Uri.file(path.join(os.homedir(), '.claude', 'hooks', 'telegram.env')),
      openLabel: text('Подключить Telegram', 'Connect Telegram'), filters: { 'Telegram environment': ['env'] } });
    if (!files?.[0] || files[0].scheme !== 'file') return;
    await this.notifications.setTelegram(await readTelegramEnv(files[0].fsPath));
    await this.notifications.setSettings({ ...this.notifications.getSettings(), telegram: true });
  }
  async manual() {
    const token = await this.vscode.window.showInputBox({ title: 'Telegram Bot Token', password: true, ignoreFocusOut: true });
    if (token === undefined) return;
    const chatId = await this.vscode.window.showInputBox({ title: 'Telegram Chat ID', password: true, ignoreFocusOut: true });
    if (chatId === undefined) return;
    await this.notifications.setTelegram({ token: token.trim(), chatId: chatId.trim() });
    await this.notifications.setSettings({ ...this.notifications.getSettings(), telegram: true });
  }
  async attach() {
    if (!this.vscode.workspace.isTrusted) throw Error('untrusted-workspace');
    const config = this.notifications.getSettings();
    if (config.hooks.length >= 8) throw Error('hook-limit');
    const files = await this.vscode.window.showOpenDialog({ canSelectMany: false, openLabel: text('Прикрепить хук', 'Attach hook'), filters: { 'Completion hook': ['js', 'cjs', 'ps1'] } });
    if (!files?.[0] || files[0].scheme !== 'file') return;
    const file = files[0].fsPath;
    if (!/\.(?:c?js|ps1)$/i.test(file) || !(await fs.stat(file)).isFile()) throw Error('invalid-hook');
    await this.notifications.setSettings({ ...config, hooks: [...new Set([...config.hooks, file])] });
  }
  async sound() {
    const platform = this.notifications.platform;
    if (!sounds.supported(platform)) throw Error('unsupported-sound-platform');
    const files = await sounds.soundFiles(platform);
    const config = this.notifications.getSettings();
    const choice = await this.vscode.window.showQuickPick([
      { label: text('Системный звук уведомления', 'System notification sound'), sound: 'system', description: text('По умолчанию', 'Default') },
      ...files,
      { label: text('Выбрать звуковой файл…', 'Choose a sound file…'), custom: true },
      { label: text('Без звука', 'No sound'), sound: '' },
    ].map(item => ({ ...item, description: item.sound === config.sound ? text('Выбран', 'Selected') : item.description })),
    { title: text('Звук завершения', 'Completion sound'), ignoreFocusOut: true });
    if (!choice) return;
    let sound = choice.sound;
    if (choice.custom) {
      const selected = await this.vscode.window.showOpenDialog({ canSelectMany: false, filters: { Audio: sounds.extensions(platform) } });
      if (!selected?.[0] || selected[0].scheme !== 'file') return;
      sound = selected[0].fsPath;
    }
    // Preview first: an unreadable/unsupported WAV must not replace a working selection.
    if (sound) await this.notifications.playSound(sound);
    await this.notifications.setSettings({ ...this.notifications.getSettings(), sound });
  }
}
module.exports = { NotificationSettings };
