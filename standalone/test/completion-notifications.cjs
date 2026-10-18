const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { CompletionNotifications, capture, redact, credentials, readTelegramEnv, SETTINGS_KEY, SECRET_KEY } = require('../runtime/completion-notifications.cjs');
const { NotificationSettings } = require('../runtime/notification-settings.cjs');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-notification-test-'));
  const data = new Map(), secretData = new Map(), calls = [], diagnostics = [];
  const state = { get: key => data.get(key), update: async (key, value) => data.set(key, value) };
  const secrets = { get: async key => secretData.get(key), store: async (key, value) => secretData.set(key, value), delete: async key => secretData.delete(key) };
  const notifier = new CompletionNotifications({ state, secrets, platform: 'win32',
    diagnostic: category => diagnostics.push(category),
    request: async (url, options) => { calls.push({ url, options });return new Response('{"ok":true}'); },
    execute: async (...args) => calls.push({ process: args }),
  });
  try {
    data.set(SETTINGS_KEY, null);assert.deepEqual(notifier.getSettings(), { telegram: false, sound: 'system', hooks: [] });
    const session = { id: 'synthetic-thread', turnId: 'synthetic-turn', cwd: directory, busy: true, items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'Synthetic prompt' }] },
      { type: 'agentMessage', turnId: 'older', phase: 'final', text: 'Old answer must not leave' },
      { type: 'agentMessage', turnId: 'synthetic-turn', phase: 'final', text: 'Synthetic final answer' },
    ] };
    const message = { method: 'turn/completed', params: { threadId: session.id, turn: { id: session.turnId, status: 'completed' } } };
    const event = capture(session, message);assert.equal(event.text, 'Synthetic final answer');
    assert.equal(event.prompt, 'Synthetic prompt', 'Hook transcript uses the real protocol user content');
    assert.equal(capture({ ...session, items: [session.items[0], { ...session.items[2], text: 42 }] }, message), null);
    assert.equal(capture({ ...session, items: [{ ...session.items[0], content: [null] }, session.items[2]] }, message).prompt, '(user request)');
    assert.equal(capture({ ...session, busy: false }, message), null);
    assert.equal(capture({ ...session, turnId: 'newer' }, message), null);
    assert.equal(capture({ ...session, preflight: { enabled: true } }, message), null);
    assert.equal(capture({ ...session, stopRequested: true }, message), null);
    assert.equal(capture(session, { ...message, params: { ...message.params, turn: { ...message.params.turn, status: 'interrupted' } } }), null);
    assert.equal(capture({ ...session, items: session.items.slice(0, 2) }, message), null);
    assert.equal(capture({ ...session, items: session.items.slice(1) }, message), null);
    assert.equal(capture(session, { ...message, params: { ...message.params, threadId: 'other' } }), null);

    const fakeToken = '123456789:' + 'A'.repeat(35);
    await assert.rejects(notifier.setTelegram({ token: 'invalid', chatId: '1' }));
    await notifier.setTelegram({ token: fakeToken, chatId: '-100123456' });
    assert.ok(secretData.get(SECRET_KEY));assert.ok(!JSON.stringify([...data]).includes(fakeToken));
    await notifier.setSettings({ telegram: true, sound: 'system' });
    notifier.dispatch(event);notifier.dispatch(event);
    await Promise.all(notifier.pending);
    assert.equal(calls.filter(call => call.url).length, 1, 'Duplicate completion delivers once');
    assert.equal(calls.filter(call => call.process).length, 1);
    assert.equal(JSON.parse(calls[0].options?.body || calls[1].options.body).text.includes('Old answer'), false);

    const secret = 'sk-proj-' + 'x'.repeat(32);
    assert.ok(!redact('key=' + secret + ' Bearer fake-secret').includes(secret));
    await notifier.telegram({ text: secret + '\n' + '😀'.repeat(5000), cwd: '' });
    const payload = JSON.parse(calls.at(-1).options.body);
    assert.ok(!payload.text.includes(secret));assert.ok(Array.from(payload.text).length <= 3800);
    notifier.request = async () => new Response('do not log this private body', { status: 403 });
    await assert.rejects(notifier.telegram(event), /telegram-http-403/);
    notifier.request = async () => new Response('{"ok":false}');
    await assert.rejects(notifier.telegram(event), /telegram-rejected/);
    notifier.request = async () => { throw Error('sensitive-network-error'); };
    notifier.dispatch({ ...event, turnId: 'failed-delivery' });await Promise.all(notifier.pending);
    assert.ok(!JSON.stringify(diagnostics).includes('sensitive-network-error'));assert.ok(diagnostics.includes('telegram-failed'));

    const env = path.join(directory, 'telegram.env');
    await fs.writeFile(env, 'TELEGRAM_BOT_TOKEN="' + fakeToken + '"\nTELEGRAM_CHAT_ID=-100123456');
    assert.deepEqual(await readTelegramEnv(env), credentials({ token: fakeToken, chatId: '-100123456' }));
    await fs.writeFile(env, 'x'.repeat(16385));await assert.rejects(readTelegramEnv(env), /invalid-env/);

    const hook = path.join(directory, 'hook with spaces.cjs');await fs.writeFile(hook, '// synthetic');
    let transcript;
    notifier.execute = async (command, args, input) => {
      const payload = JSON.parse(input);transcript = payload.transcript_path;
      assert.equal(payload.hook_event_name, 'Stop');assert.equal(payload.last_assistant_message, event.text);
      const rows = (await fs.readFile(transcript, 'utf8')).split('\n').map(line => JSON.parse(line));
      assert.equal(rows.length, 2);assert.equal(rows[1].message.content[0].text, event.text);
      assert.equal(args.at(-1), hook);
      throw Error('synthetic-hook-failure');
    };
    await assert.rejects(notifier.hook(hook, event));
    await assert.rejects(fs.stat(transcript), { code: 'ENOENT' });
    await assert.rejects(notifier.hook('relative.cjs', event));
    await notifier.setSettings({ hooks: [hook], sound: '' });notifier.trusted = () => false;
    let ran = false;notifier.execute = async () => { ran = true; };
    await notifier.deliver(event, notifier.getSettings());assert.equal(ran, false, 'Untrusted workspace does not execute attached scripts');

    const sound = path.join(directory, "sound ' ; $.wav");await fs.writeFile(sound, 'synthetic');
    const processes = [];notifier.execute = async (...args) => processes.push(args);
    await notifier.playSound(sound);
    assert.equal(processes[0][3].CODEX_NOTIFICATION_SOUND, sound);
    assert.ok(!processes[0][1].join(' ').includes(sound), 'Selected path is data, never PowerShell code');
    await assert.rejects(notifier.playSound(hook));

    // Exercise the real child lifecycle with a synthetic Node hook, not user scripts.
    const real = new CompletionNotifications({ state, secrets });
    const marker = path.join(directory, 'marker.json');
    await fs.writeFile(hook, `const fs=require('node:fs');let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({event:JSON.parse(data).hook_event_name})));`);
    await real.hook(hook, event);assert.equal(JSON.parse(await fs.readFile(marker, 'utf8')).event, 'Stop');
    if (process.platform === 'win32') {
      const powershell = path.join(directory, 'synthetic.ps1');
      await fs.writeFile(powershell, "$payload = [Console]::In.ReadToEnd(); [IO.File]::WriteAllText([IO.Path]::ChangeExtension($PSCommandPath, '.json'), $payload, [Text.Encoding]::UTF8)");
      await real.hook(powershell, { ...event, text: 'Русский итог — проверка' });
      const received = JSON.parse((await fs.readFile(path.join(directory, 'synthetic.json'), 'utf8')).replace(/^\uFEFF/, ''));
      assert.equal(received.last_assistant_message, 'Русский итог — проверка', 'PowerShell hooks receive UTF-8 Russian content');
    }
    await assert.rejects(real.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], '', { ELECTRON_RUN_AS_NODE: '1' }, 100));
    assert.equal(real.children.size, 0);real.dispose();

    // Settings flow imports only the chosen env, into SecretStorage; no workspace settings.
    const choices = [{ id: 'import' }, undefined];
    await fs.writeFile(env, 'TELEGRAM_BOT_TOKEN=' + fakeToken + '\nTELEGRAM_CHAT_ID=123');
    const ui = new NotificationSettings({ Uri: { file: fsPath => ({ fsPath }) }, workspace: { isTrusted: true }, window: {
      showQuickPick: async () => choices.shift(), showOpenDialog: async () => [{ scheme: 'file', fsPath: env }],
      showErrorMessage: () => { throw Error('Unexpected settings error'); },
    } }, notifier);
    await ui.configure();assert.equal(notifier.getSettings().telegram, true);assert.equal(ui.open, false);
    assert.ok(!JSON.stringify(data.get(SETTINGS_KEY)).includes(fakeToken));
    notifier.dispose();const count = calls.length;notifier.dispatch({ ...event, turnId: 'disposed' });assert.equal(calls.length, count);
    console.log('PASS: completion ownership/deduplication, Telegram secret storage/redaction/failure, hook stdin/cleanup/timeout/trust, sound path safety and settings import');
  } finally {
    notifier.dispose();await fs.rm(directory, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error);process.exitCode = 1; });
