const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AppServer } = require('../runtime/transport.cjs');

exports.run = async () => {
  const report = { syntheticTransport: true, inferencePerformed: false };
  const original = { start: AppServer.prototype.start, request: AppServer.prototype.request, home: process.env.CODEX_HOME };
  let api;
  const starts = [], turns = [];
  try {
    process.env.CODEX_HOME = path.join(__dirname, '../.verification/new-session-empty-home');
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    await vscode.workspace.getConfiguration('rundix').update('cliPath', process.execPath, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('rundix').update('cliAutoUpdate', false, vscode.ConfigurationTarget.Global);
    AppServer.prototype.start = async function () { return this; };
    AppServer.prototype.request = async function (method, params) {
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' } };
      if (method === 'account/rateLimits/read') return { rateLimits: {} };
      if (method === 'model/list') return { data: [{ model: 'fixture', defaultReasoningEffort: 'high', serviceTiers: ['priority'],
        supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null };
      if (method === 'config/read') return { config: { model: 'fixture', model_reasoning_effort: 'high' } };
      if (method === 'thread/start') {
        starts.push(params);
        return { thread: { id: 'synthetic-new-thread-'+starts.length, cwd: params.cwd }, model: 'fixture', reasoningEffort: 'high' };
      }
      if (method === 'turn/start') { turns.push(params);return { turn: { id: 'synthetic-turn' } }; }
      return {};
    };
    api = await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();
    const first = api.create();
    assert.equal(first.prefs.access, 'workspace');
    await api.handle(first, { action: 'mode', mode: 'full' });
    first.model = 'fixture'; first.effort = 'high'; first.prefs.fast = true;
    first.draft = 'Synthetic draft'; first.attachments = [{ path: 'synthetic.png' }];
    const next = await vscode.commands.executeCommand('rundix.new');
    assert.equal(next.prefs.mode, 'full');
    assert.equal(next.model, 'fixture'); assert.equal(next.effort, 'high'); assert.equal(next.prefs.fast, true);
    assert.equal(next.draft || '', ''); assert.deepEqual(next.attachments, []); assert.deepEqual(next.items, []);
    next.prefs.fast = false; assert.equal(first.prefs.fast, true);
    await api.handle(next, { action: 'send', text: 'Synthetic request' });
    assert.equal(starts[0].sandbox, 'danger-full-access'); assert.equal(starts[0].approvalPolicy, 'never');
    next.busy = false;
    await api.handle(next, { action: 'mode', mode: 'manual' });
    const beside = await vscode.commands.executeCommand('rundix.beside');
    assert.equal(beside.prefs.mode, 'manual');
    const restored = api.create({ key: 'synthetic-restored', prefs: { mode: 'workspace', access: 'workspace' } });
    assert.equal(restored.prefs.mode, 'workspace');
    restored.cwd = path.join(restored.cwd, 'different-project');
    await api.handle(restored, { action: 'preferences', focus: false });
    api.select(restored);
    for (let attempt = 0; attempt < 100 && !api.view(restored).panel.active; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(api.view(restored).panel.active, true);
    const isolated = api.create();
    assert.equal(isolated.prefs.access, 'workspace');
    await require('./queued-session-transfer-host-checks.cjs')({api,starts,turns});
    report.queuedTaskMovesToIndependentSession=true;
    report.passed = true;
    report.inheritedAndAppliedToRpc = true;
    report.restoredAndOtherProjectsIsolated = true;
  } catch (error) {
    report.passed = false; report.error = error.message;
    report.testLine = error.stack?.match(/new-session-host\.cjs:(\d+)/)?.[1];
  } finally {
    for (const session of api?.sessions.values() || []) api.view(session).panel?.dispose();
    AppServer.prototype.start = original.start; AppServer.prototype.request = original.request;
    if (original.home === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original.home;
    fs.writeFileSync(path.join(__dirname, '../.verification/new-session-host.json'), JSON.stringify(report, null, 2));
  }
  assert.ok(report.passed, report.error);
};
