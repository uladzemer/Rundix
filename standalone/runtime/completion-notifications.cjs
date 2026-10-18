const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { itemText } = require('./session.cjs');
const sounds = require('./notification-sounds.cjs');

const SETTINGS_KEY = 'completionNotifications.v1';
const SECRET_KEY = 'completionNotifications.telegram.v1';

function settings(value = {}, platform = process.platform) {
  if (!value || typeof value !== 'object') value = {};
  return {
    telegram: value.telegram === true,
    sound: typeof value.sound === 'string' ? value.sound : sounds.defaultSound(platform),
    hooks: Array.isArray(value.hooks) ? value.hooks.filter(file => typeof file === 'string' && path.isAbsolute(file) && /\.(?:c?js|ps1)$/i.test(file)).slice(0, 8) : [],
  };
}

function redact(text) {
  return String(text || '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED]')
    .replace(/\b(?:sk-(?:ant-|proj-|svcacct-)?|gh[pousr]_|github_pat_|AIza|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(\b(?:Bearer|Basic)\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|password|passwd|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi, '$1[REDACTED]');
}

function capture(session, message) {
  const turn = message.params?.turn;
  if (message.method !== 'turn/completed' || !session.busy || !session.id ||
      message.params?.threadId !== session.id || !session.turnId || turn?.id !== session.turnId ||
      turn.status !== 'completed' || session.stopRequested || session.preflight?.enabled) return null;
  const items = session.items.filter(item => item.turnId === turn.id);
  const final = items.findLast(item => item.type === 'agentMessage' && ['final', 'final_answer'].includes(item.phase)) ||
    items.findLast(item => item.type === 'agentMessage' && !item.phase);
  const user = session.items.findLast(item => item.type === 'userMessage');
  if (!user || typeof final?.text !== 'string' || !final.text.trim()) return null;
  const content = Array.isArray(user.content) ? user.content.filter(part => part && typeof part.text === 'string') : [];
  return Object.freeze({ threadId: session.id, turnId: turn.id, cwd: session.cwd || '',
    prompt: itemText({ ...user, content }).slice(0, 32000) || '(user request)',
    text: final.text.slice(0, 128000) });
}

function credentials(value) {
  if (!value || typeof value.token !== 'string' || !/^\d{5,15}:[A-Za-z0-9_-]{20,150}$/.test(value.token) ||
      typeof value.chatId !== 'string' || !/^(?:-?\d{1,30}|@[A-Za-z0-9_]{5,64})$/.test(value.chatId)) throw Error('invalid-credentials');
  return { token: value.token, chatId: value.chatId };
}

async function readTelegramEnv(file) {
  if ((await fs.stat(file)).size > 16384) throw Error('invalid-env');
  const data = await fs.readFile(file, 'utf8'), values = {};
  for (const line of data.split(/\r?\n/)) {
    const match = line.match(/^\s*(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return credentials({ token: values.TELEGRAM_BOT_TOKEN, chatId: values.TELEGRAM_CHAT_ID });
}

class CompletionNotifications {
  constructor({ state, secrets, diagnostic = () => {}, request = fetch, execute, platform = process.platform, trusted = () => true }) {
    this.state = state; this.secrets = secrets; this.diagnostic = diagnostic;
    this.request = request; this.platform = platform; this.trusted = trusted; this.children = new Set(); this.controllers = new Set();
    this.execute = execute || ((...args) => this.run(...args));
    this.pending = new Set(); this.seen = new Set(); this.disposed = false;
  }
  getSettings() { return settings(this.state.get(SETTINGS_KEY), this.platform); }
  async setSettings(value) { await this.state.update(SETTINGS_KEY, settings(value, this.platform)); }
  async setTelegram(value) { await this.secrets.store(SECRET_KEY, JSON.stringify(credentials(value))); }
  async hasTelegram() { return !!await this.secrets.get(SECRET_KEY); }
  async clearTelegram() { await this.secrets.delete(SECRET_KEY); }
  report(category) { if (!this.disposed) this.diagnostic(category); }
  dispatch(event) {
    if (!event || this.disposed) return;
    const key = JSON.stringify([event.threadId, event.turnId]);
    if (this.seen.has(key)) return;
    this.seen.add(key); if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value);
    if (this.pending.size >= 8) { this.report('queue-full'); return; }
    const config = this.getSettings();
    const job = this.deliver(event, config).catch(() => this.report('delivery-failed'));
    this.pending.add(job); void job.finally(() => this.pending.delete(job));
  }
  async deliver(event, config) {
    const tasks = [], channels = [];
    const add = (channel, task) => { channels.push(channel);tasks.push(task); };
    if (config.telegram) add('telegram', this.telegram(event));
    if (config.sound) add('sound', this.playSound(config.sound));
    if (this.trusted()) for (const file of config.hooks) add('hook', this.hook(file, event));
    const results = await Promise.allSettled(tasks);
    results.forEach((result, index) => { if (result.status === 'rejected') this.report(channels[index] + '-failed'); });
  }
  async telegram(event) {
    const raw = await this.secrets.get(SECRET_KEY);
    if (this.disposed) return;
    const value = credentials(JSON.parse(raw || '{}'));
    const controller = new AbortController();this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const heading = '[OK] Rundix\n' + (event.cwd ? path.basename(event.cwd) + '\n\n' : '\n');
      const text = Array.from(redact(heading + event.text));
      const body = JSON.stringify({ chat_id: value.chatId, text: text.length > 3800 ? text.slice(0, 3790).join('') + '\n…' : text.join(''), link_preview_options: { is_disabled: true } });
      const response = await this.request('https://api.telegram.org/bot' + value.token + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) { await response.body?.cancel();throw Error('telegram-http-' + response.status); }
      const chunks = [];let size = 0;
      for await (const chunk of response.body) {
        chunks.push(Buffer.from(chunk));size += chunk.length;
        if (size > 65536) { controller.abort();throw Error('telegram-response-size'); }
      }
      if (JSON.parse(Buffer.concat(chunks).toString('utf8')).ok !== true) throw Error('telegram-rejected');
    } finally { clearTimeout(timer);this.controllers.delete(controller); }
  }
  async playSound(sound) {
    await sounds.playSound(sound, { platform: this.platform, execute: this.execute });
  }
  async hook(file, event) {
    if (!path.isAbsolute(file) || !/\.(?:c?js|ps1)$/i.test(file) || !(await fs.stat(file)).isFile()) throw Error('invalid-hook');
    if (this.disposed) return;
    // Only this turn is exported for Claude Stop compatibility; never read a real transcript.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-completion-'));
    try {
      const transcript = path.join(directory, 'transcript.jsonl');
      await fs.writeFile(transcript, [
        { type: 'user', message: { content: [{ type: 'text', text: event.prompt }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: event.text }] } },
      ].map(row => JSON.stringify(row)).join('\n'), { mode: 0o600 });
      const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: event.threadId, turn_id: event.turnId,
        cwd: event.cwd, transcript_path: transcript, last_assistant_message: event.text, stop_hook_active: false });
      const powershell = /\.ps1$/i.test(file);
      const wrapper = '$ErrorActionPreference = "Stop"; [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false); & $env:CODEX_COMPLETION_HOOK';
      await this.execute(powershell ? 'powershell.exe' : process.execPath,
        powershell ? ['-NoProfile', '-NonInteractive', '-Command', wrapper] : [file], payload,
        powershell ? { CODEX_COMPLETION_HOOK: file } : { ELECTRON_RUN_AS_NODE: '1' }, 10000, event.cwd || undefined);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  run(command, args, input, environment, timeout, cwd) {
    if (this.disposed) return Promise.reject(Error('disposed'));
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, windowsHide: true, shell: false, env: { ...process.env, ...environment }, stdio: ['pipe', 'ignore', 'ignore'] });
      this.children.add(child);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true;this.kill(child); }, timeout);
      child.stdin.on('error', () => {}); // Exit before stdin consumption is reported by close/exit status.
      child.once('error', () => { clearTimeout(timer);this.children.delete(child);reject(Error('process-start-failed')); });
      child.once('close', code => { clearTimeout(timer);this.children.delete(child);!timedOut && code === 0 ? resolve() : reject(Error('process-failed')); });
      child.stdin.end(input);
    });
  }
  kill(child) {
    if (this.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 2000 });
      killer.on('error', () => child.kill());
      killer.once('close', code => { if (code !== 0) child.kill(); });
    } else child.kill('SIGKILL');
  }
  dispose() {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    for (const child of this.children) this.kill(child);
  }
}

module.exports = { CompletionNotifications, capture, redact, credentials, readTelegramEnv, SETTINGS_KEY, SECRET_KEY };
