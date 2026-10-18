const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {AppServer, findCli} = require('../runtime/transport.cjs');

exports.run = async () => {
  const report = {syntheticTransport: true, inferencePerformed: false};
  const original = {start: AppServer.prototype.start, request: AppServer.prototype.request, home: process.env.CODEX_HOME};
  const calls = [], states = [];
  let api, session, originalPost;
  let currentAccount = {type: 'chatgpt', email: 'local@example.test', planType: 'plus'};
  let usedPercent = 20;
  let failAccount = false;
  try {
    const config = vscode.workspace.getConfiguration('rundix');
    await config.update('cliPath', findCli(), vscode.ConfigurationTarget.Global);
    await config.update('cliAutoUpdate', false, vscode.ConfigurationTarget.Global);
    process.env.CODEX_HOME = path.join(__dirname, '../.verification/local-auth-empty-home');
    fs.mkdirSync(process.env.CODEX_HOME, {recursive: true});
    const sentinel = '{"synthetic_fixture":"must remain unchanged"}\n';
    const fixtureAuth = path.join(process.env.CODEX_HOME, 'auth.json');
    fs.writeFileSync(fixtureAuth, sentinel);
    AppServer.prototype.start = async function () { return this; };
    AppServer.prototype.request = async function (method, params) {
      calls.push({method, params});
      if (method === 'account/read') {
        assert.deepEqual(params, {refreshToken: false});
        if (failAccount) throw Error('Synthetic account read failure');
        return {account: currentAccount};
      }
      if (method === 'account/rateLimits/read') return {rateLimits: {primary: {usedPercent, windowDurationMins: 300, resetsAt: Date.now()/1000 + 3600}}};
      if (method === 'model/list') return {data: [{model: 'fixture', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{reasoningEffort: 'medium'}]}], nextCursor: null};
      if (method === 'config/read') return {config: {model: 'fixture', model_reasoning_effort: 'medium'}};
      if (method === 'thread/start') return {thread: {id: 'local-auth-thread', cwd: process.cwd()}, model: 'fixture', reasoningEffort: 'medium'};
      if (method === 'turn/start') return {turn: {id: 'local-auth-turn'}};
      if (method === 'thread/name/set') return {};
      throw Error('Unexpected RPC: ' + method);
    };
    api = await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();
    session = api.create();
    originalPost = session.panel.webview.postMessage;
    session.panel.webview.postMessage = function (message) {
      if (message.type === 'state') states.push(message.data);
      return originalPost.call(this, message);
    };
    await api.handle(session, {action: 'accountRefresh'});
    for (let attempt = 0; attempt < 100 && states.at(-1)?.account?.email !== currentAccount.email; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(states.at(-1).account.email, currentAccount.email);
    for (const field of ['cloudAuth', 'savedAccounts', 'accountUsage', 'accountRotation']) assert.equal(field in states.at(-1), false);
    session.draft = 'Preserve my draft';
    currentAccount = null;
    await api.handle(session, {action: 'accountRefresh'});
    await assert.rejects(api.handle(session, {action: 'send', text: session.draft}));
    assert.equal(session.draft, 'Preserve my draft');
    assert.equal(calls.some(call => call.method === 'turn/start'), false);
    currentAccount = {type: 'chatgpt', email: 'local@example.test'};
    usedPercent = 100;
    await api.handle(session, {action: 'accountRefresh'});
    await assert.rejects(api.handle(session, {action: 'send', text: session.draft}));
    assert.equal(calls.some(call => call.method === 'turn/start'), false);
    failAccount = true;
    await assert.rejects(api.handle(session, {action: 'accountRefresh'}), /Synthetic account read failure/);
    failAccount = false;
    usedPercent = 20;
    await api.handle(session, {action: 'accountRefresh'});
    await api.handle(session, {action: 'send', text: session.draft});
    assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(calls.some(call => /login|logout|AuthStatus|refresh.*token/i.test(call.method)), false);
    assert.equal(fs.readFileSync(fixtureAuth, 'utf8'), sentinel);
    assert.ok(fs.readdirSync(process.env.CODEX_HOME).every(name => ['auth.json', 'tmp'].includes(name)), 'Only the synthetic auth fixture and ordinary attachment staging directory are allowed');
    report.localAccountOnly = true;
    report.signedOutAndExhaustedDraftPreserved = true;
    report.readFailureRecovers = true;
    report.credentialsUntouched = true;
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = String(error.message).slice(0, 300);
  } finally {
    if (session?.panel && originalPost) session.panel.webview.postMessage = originalPost;
    session?.panel?.dispose();
    Object.assign(AppServer.prototype, {start: original.start, request: original.request});
    if (original.home === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original.home;
    fs.mkdirSync(path.join(__dirname, '../.verification'), {recursive: true});
    fs.writeFileSync(path.join(__dirname, '../.verification/local-auth-host.json'), JSON.stringify(report, null, 2));
  }
  if (!report.passed) throw Error(report.error);
};
