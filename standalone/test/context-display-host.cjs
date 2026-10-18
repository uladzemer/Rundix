const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

exports.run = async () => {
  const report = { synthetic: true, inferencePerformed: false };
  let session;
  try {
    const config = vscode.workspace.getConfiguration('rundix');
    await config.update('cliAutoUpdate', false, vscode.ConfigurationTarget.Global);
    const api = await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();
    session = api.create();
    const states = [], original = session.panel.webview.postMessage;
    session.panel.webview.postMessage = async function(message) { if (message.type === 'state') states.push(message.data);return original.call(this, message); };
    await api.handle(session, { action: 'contextDisplay', value: 'ring' });
    assert.equal(vscode.workspace.getConfiguration('rundix').get('contextDisplay'), 'ring');
    for (let attempt = 0; attempt < 30 && !states.some(state => state.contextDisplay === 'ring'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(states.some(state => state.contextDisplay === 'ring'));report.savedAndPublished = true;
    await api.handle(session, { action: 'contextDisplay', value: 'unexpected' });assert.equal(vscode.workspace.getConfiguration('rundix').get('contextDisplay'), 'ring');
    await api.handle(session, { action: 'contextDisplay', value: 'percent' });assert.equal(vscode.workspace.getConfiguration('rundix').get('contextDisplay'), 'percent');
    report.invalidRejectedAndRestored = true;report.passed = true;
  } finally {
    session?.panel?.dispose();
    fs.writeFileSync(path.join(__dirname, '../.verification/context-display-host.json'), JSON.stringify(report, null, 2));
  }
};
