const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AppServer, findCli } = require('../runtime/transport.cjs');
const { CompletionNotifications } = require('../runtime/completion-notifications.cjs');

exports.run = async () => {
  const report = { syntheticTransport: true, telegramSent: false, inferencePerformed: false };
  const original = { start: AppServer.prototype.start, request: AppServer.prototype.request,
    deliver: CompletionNotifications.prototype.deliver, home: process.env.CODEX_HOME };
  const deliveries = [];let api, session;
  try {
    await vscode.workspace.getConfiguration('rundix').update('cliPath', findCli(), vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('rundix').update('cliAutoUpdate', false, vscode.ConfigurationTarget.Global);
    process.env.CODEX_HOME = path.join(__dirname, '../.verification/notifications-empty-home');
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    AppServer.prototype.start = async function() { return this; };
    AppServer.prototype.request = async function(method) {
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'synthetic@example.test' } };
      if (method === 'model/list') return { data: [], nextCursor: null };
      if (method === 'config/read') return { config: {} };
      return {};
    };
    CompletionNotifications.prototype.deliver = async event => { deliveries.push(event); };
    api = await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();
    session = api.create();await api.connect();
    Object.assign(session, { id: 'notification-thread', turnId: 'notification-turn', busy: true, items: [
      { id: 'synthetic-user', type: 'userMessage', content: [{ type: 'text', text: 'Synthetic task' }] },
      { id: 'synthetic-answer', type: 'agentMessage', phase: 'final', turnId: 'notification-turn', text: 'Synthetic completion' },
    ] });
    const event = { method: 'turn/completed', params: { threadId: session.id, turn: { id: session.turnId, status: 'completed' } } };
    api.server().emit('notification', event);api.server().emit('notification', event);
    assert.equal(deliveries.length, 1);assert.equal(deliveries[0].text, 'Synthetic completion');
    assert.equal(session.busy, false);report.oneDeliveryAfterCompletion = true;
    Object.assign(session, { busy: true, turnId: 'next-turn', stopRequested: true });
    api.server().emit('notification', { ...event, params: { threadId: session.id, turn: { id: 'next-turn', status: 'completed' } } });
    assert.equal(deliveries.length, 1);report.stoppedTurnSilent = true;
    const commands = await vscode.commands.getCommands();assert.ok(commands.includes('rundix.notifications'));
    report.settingsCommandRegistered = true;
    // Actual Windows sound process, with no chat or credential access. Audible output is not asserted.
    const probe = new CompletionNotifications({ state: { get: () => undefined }, secrets: {} });
    try {
      await probe.playSound('system');report.windowsSoundProcessPassed = true;
      const hook = path.join(__dirname, '../.verification/notification-synthetic-hook.cjs');
      const marker = path.join(__dirname, '../.verification/notification-synthetic-marker.json');
      fs.writeFileSync(hook, `let input='';process.stdin.on('data',part=>input+=part);process.stdin.on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({event:JSON.parse(input).hook_event_name})));`);
      await probe.hook(hook, { threadId: 'synthetic', turnId: 'synthetic', cwd: process.cwd(), prompt: 'Synthetic prompt', text: 'Synthetic final answer' });
      assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).event, 'Stop');report.realElectronNodeHookPassed = true;
    }
    finally { probe.dispose(); }
    report.passed = true;
  } finally {
    AppServer.prototype.start = original.start;AppServer.prototype.request = original.request;
    CompletionNotifications.prototype.deliver = original.deliver;
    if (original.home === undefined) delete process.env.CODEX_HOME;else process.env.CODEX_HOME = original.home;
    if (session) session.panel?.dispose();api?.server()?.dispose();
    fs.writeFileSync(path.join(__dirname, '../.verification/notifications-host.json'), JSON.stringify(report, null, 2));
  }
};
