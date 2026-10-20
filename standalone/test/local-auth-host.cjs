const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {AppServer, findCli} = require('../runtime/transport.cjs');

exports.run = async () => {
  const report = {syntheticTransport: true, inferencePerformed: false};
  const original = {start: AppServer.prototype.start, request: AppServer.prototype.request, home: process.env.CODEX_HOME, openExternal: vscode.env.openExternal};
  const calls = [], states = [];
  let api, session, originalPost;
  let currentAccount = {type: 'chatgpt', email: 'local@example.test', planType: 'plus'};
  let usedPercent = 20;
  let failAccount = false, immediateCompletion = false;
  try {
    const config = vscode.workspace.getConfiguration('rundix');
    const userCli = findCli();
    await config.update('cliPath', userCli, vscode.ConfigurationTarget.Global);
    await config.update('cliAutoUpdate', false, vscode.ConfigurationTarget.Global);
    await assert.rejects(config.update('cliPath', 'synthetic-workspace-cli-must-never-run', vscode.ConfigurationTarget.Workspace), /only into User settings/);
    assert.equal(require('../package.json').contributes.configuration.properties['rundix.cliPath'].scope, 'machine');
    let openBrowser = async () => true;
    vscode.env.openExternal = (...args) => openBrowser(...args);
    let client;
    process.env.CODEX_HOME = path.join(__dirname, '../.verification/local-auth-empty-home');
    fs.mkdirSync(process.env.CODEX_HOME, {recursive: true});
    const sentinel = '{"synthetic_fixture":"must remain unchanged"}\n';
    const fixtureAuth = path.join(process.env.CODEX_HOME, 'auth.json');
    fs.writeFileSync(fixtureAuth, sentinel);
    AppServer.prototype.start = async function () { client = this; assert.equal(this.executable, path.resolve(userCli)); return this; };
    AppServer.prototype.request = async function (method, params) {
      calls.push({method, params});
      if (method === 'account/login/start') {
        if (immediateCompletion) this.emit('notification', {method:'account/login/completed', params:{loginId:'synthetic-login',success:false}});
        return {loginId: 'synthetic-login', authUrl: 'https://example.test/synthetic-login'};
      }
      if (method === 'account/login/cancel') return {};
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
    await api.handle(session, {action: 'account'});
    await assert.rejects(api.handle(session, {action: 'send', text: session.draft}), /меню аккаунта|account menu/);
    await assert.rejects(api.handle(session, {action: 'connectionSettings'}), /sign-in/i);
    assert.equal(session.draft, 'Preserve my draft');
    client.emit('notification', {method:'account/login/completed',params:{loginId:'stale-login',success:true}});
    await assert.rejects(api.handle(session, {action:'send',text:session.draft}));
    await api.handle(session, {action:'accountCancel'});
    let releaseBrowser;
    openBrowser = () => new Promise(resolve => { releaseBrowser = resolve; });
    const firstLogin = api.handle(session, {action:'account'});
    for (let attempt=0; !releaseBrowser && attempt<100; attempt++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(releaseBrowser);
    client.emit('notification', {method:'account/login/completed',params:{loginId:'synthetic-login',success:false}});
    openBrowser = async () => true;
    await api.handle(session, {action:'account'});
    releaseBrowser(true);
    await firstLogin;
    await assert.rejects(api.handle(session, {action:'accountRefresh'}), /connection change/);
    await assert.rejects(api.handle(session, {action:'send',text:session.draft}));
    await api.handle(session, {action:'accountCancel'});
    report.staleLoginKeepsNewOwnerBusy = true;
    // External history invalidates a loaded server without emitting disconnected.
    // Its browser-login lease and authBusy must both finish before reconnecting.
    session.id='synthetic-history-thread';session.loaded=true;
    session.items=[];
    await api.handle(session,{action:'account'});
    const external=api.store.session(session.key);
    api.store.saveSession({...external,items:[{id:'synthetic-history-item',type:'userMessage',text:'Synthetic history'}]});
    session.host.ready=true;api.select(session,false);
    for(let attempt=0;session.loaded && attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(session.loaded,false);
    await api.handle(session,{action:'accountRefresh'});
    api.store.acquire('account-credentials')();
    report.externalHistoryFinishesPendingLogin = true;
    session.id=null;session.loaded=false;session.items=[];
    immediateCompletion = true;
    await api.handle(session, {action:'account'});
    report.immediateLoginCompletionHandled = true;
    await api.handle(session, {action: 'send', text: session.draft});
    assert.equal(calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(calls.some(call => /logout|AuthStatus|refresh.*token/i.test(call.method)), false);
    report.pendingLoginBlocksSendAndConnectionChanges = true;
    report.workspaceExecutableIgnored = true;
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
    vscode.env.openExternal = original.openExternal;
    Object.assign(AppServer.prototype, {start: original.start, request: original.request});
    if (original.home === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original.home;
    fs.mkdirSync(path.join(__dirname, '../.verification'), {recursive: true});
    fs.writeFileSync(path.join(__dirname, '../.verification/local-auth-host.json'), JSON.stringify(report, null, 2));
  }
  if (!report.passed) throw Error(report.error);
};
