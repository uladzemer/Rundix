const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AppServer } = require('../runtime/transport.cjs');

exports.run = async () => {
  const report = { syntheticTransport: true, inferencePerformed: false };
  const previous = { start: AppServer.prototype.start, request: AppServer.prototype.request, home: process.env.CODEX_HOME };
  let session, timeout;
  try {
    process.env.CODEX_HOME = path.join(__dirname, '../.verification/toggle-empty-home');
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    await vscode.workspace.getConfiguration('rundix').update('cliPath', process.execPath, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('rundix').update('cliAutoUpdate', false, vscode.ConfigurationTarget.Global);
    AppServer.prototype.start = async function () { return this; };
    AppServer.prototype.request = async function (method) {
      if (method === 'account/read') return { account: null };
      if (method === 'account/rateLimits/read') return { rateLimits: {} };
      if (method === 'model/list') return { data: [{ model: 'fixture', defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: null };
      if (method === 'config/read') return { config: { model: 'fixture', model_reasoning_effort: 'medium' } };
      throw Error('Unexpected synthetic RPC');
    };
    const api = await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();
    session = api.create();
    session.busy = true; // Preparation must be refused without starting any CLI work.
    const result = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(Error('Toggle host probe timed out')), 20000);
      session.panel.webview.onDidReceiveMessage(message => {
        if (message.action === 'toggleProbe') resolve(message.report);
      });
    });
    const html = session.panel.webview.html;
    const nonce = html.match(/nonce="([^"]+)"/)[1];
    session.panel.webview.html = html.replace('</body>', `<script nonce="${nonce}">
      (async () => {
        const seen = [];
        window.addEventListener('message', event => {
          const message = event.data;
          if (message.type === 'state') seen.push({ type: 'state', focus: message.data.prefs.focus, error: !!message.data.error });
          if (message.type === 'toggleResult') seen.push({ type: message.type, id: message.requestId, ok: message.ok, key: message.key });
        });
        const receive = predicate => new Promise((resolve, reject) => {
          const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(Error('Missing toggle response')); }, 10000);
          const listener = event => {
            if (!predicate(event.data)) return;
            clearTimeout(timer);window.removeEventListener('message', listener);resolve(event.data);
          };
          window.addEventListener('message', listener);
        });
        try {
          const success = receive(message => message.type === 'toggleResult' && message.requestId === 'synthetic-success');
          vscode.postMessage({ action: 'preferences', sessionKey: ${JSON.stringify(session.key)}, focus: true, toggleRequestId: 'synthetic-success' });
          await success;
          const rejected = receive(message => message.type === 'toggleResult' && message.requestId === 'synthetic-rejected');
          vscode.postMessage({ action: 'preflight', sessionKey: ${JSON.stringify(session.key)}, enabled: true, toggleRequestId: 'synthetic-rejected' });
          await rejected;
          const legacy = receive(message => message.type === 'state' && message.data.prefs.focus === false);
          vscode.postMessage({ action: 'preferences', sessionKey: ${JSON.stringify(session.key)}, focus: false });
          await legacy;
          await new Promise(resolve => setTimeout(resolve, 50));
          vscode.postMessage({ action: 'toggleProbe', report: { seen } });
        } catch (error) { vscode.postMessage({ action: 'toggleProbe', report: { error: error.message } }); }
      })();</script></body>`);
    const observed = await result;
    assert.ok(!observed.error, observed.error);
    const replies = observed.seen.filter(item => item.type === 'toggleResult');
    assert.deepEqual(replies.map(item => [item.id, item.ok, item.key]),
      [['synthetic-success', true, session.key], ['synthetic-rejected', false, session.key]]);
    const acceptedIndex = observed.seen.findIndex(item => item.id === 'synthetic-success');
    const rejectedIndex = observed.seen.findIndex(item => item.id === 'synthetic-rejected');
    assert.ok(observed.seen.slice(0, acceptedIndex).some(item => item.type === 'state' && item.focus === true));
    assert.ok(observed.seen.slice(acceptedIndex + 1, rejectedIndex).some(item => item.type === 'state' && item.error));
    assert.equal(session.prefs.focus, false);
    report.passed = true;
    report.authoritativeStateBeforeResult = true;
    report.legacyMessageSupported = true;
  } catch (error) {
    report.passed = false;
    report.error = error.message;
  } finally {
    clearTimeout(timeout);
    session?.panel?.dispose();
    AppServer.prototype.start = previous.start;
    AppServer.prototype.request = previous.request;
    if (previous.home === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.home;
    fs.writeFileSync(path.join(__dirname, '../.verification/toggle-response-host.json'), JSON.stringify(report, null, 2));
  }
  assert.ok(report.passed, report.error);
};
