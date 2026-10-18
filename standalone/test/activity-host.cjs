const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

exports.run = async () => {
  const root = path.resolve(__dirname, '..');
  const panel = vscode.window.createWebviewPanel('activityFixture', 'Activity fixture',
    vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [vscode.Uri.file(root)] });
  const fixture = {
    key: 'activity-fixture', id: 'synthetic-thread', busy: true, turnId: 'synthetic-turn', turnStartedAt: Date.now(),
    model: 'fixture', effort: 'low', activityMotion: 'on',
    models: [{ model: 'fixture', displayName: 'Fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }],
    prefs: { access: 'workspace', focus: false, showThinking: true }, requests: [], attachments: [],
    items: [{ id: 'synthetic-reasoning', type: 'reasoning', turnId: 'synthetic-turn', status: 'inProgress', text: 'Synthetic reasoning' }],
  };
  const scripts = ['translations', 'i18n', 'forms', 'questions', 'question-panel', 'task-preflight',
    'icons', 'tabs', 'controls', 'toggles', 'modes', 'speed', 'changes', 'limits', 'limits-view',
    'markdown', 'markdown-view', 'messages', 'activity', 'transcript-scroll', 'queued-editor', 'app'];
  const uri = file => panel.webview.asWebviewUri(vscode.Uri.file(path.join(root, 'ui', file)));
  let timer;
  const pending = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error('Activity webview probe timed out')), 20000);
    panel.webview.onDidReceiveMessage(message => {
      if (message.action === 'ready') panel.webview.postMessage({ type: 'state', data: fixture });
      if (message.action === 'activityProbe') resolve(message.report);
    });
  });
  panel.webview.html = `<!doctype html><html data-language="ru"><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-activity'; img-src ${panel.webview.cspSource} data:;">
    <link rel="stylesheet" href="${uri('app.css')}"></head><body><main id="app"></main>
    <script nonce="activity">window.activityApi = acquireVsCodeApi(); window.acquireVsCodeApi = () => window.activityApi;</script>
    ${scripts.map(name => `<script nonce="activity" src="${uri(name + '.js')}"></script>`).join('')}
    <script nonce="activity">
    (async () => {
      try {
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        while (!document.querySelector('.activity-spinner')) await frame();
        const footer = document.querySelector('.activity-status'), spinner = footer.querySelector('.activity-spinner');
        const start = getComputedStyle(spinner).transform;
        for (let index = 0; index < 8; index++) await frame();
        const report = { reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          insideTranscript: footer.parentElement.classList.contains('messages') && footer === footer.parentElement.lastElementChild,
          animation: getComputedStyle(spinner).animationName, moved: getComputedStyle(spinner).transform !== start,
          phase: footer.dataset.phase };
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', data: { ...${JSON.stringify(fixture)}, busy: false } } }));
        report.idleRemoved = !document.querySelector('.activity-status');
        report.timerCleared = activityView.timer === null;
        window.activityApi.postMessage({ action: 'activityProbe', report });
      } catch { window.activityApi.postMessage({ action: 'activityProbe', report: { failed: true } }); }
    })();
    </script></body></html>`;
  let result;
  try {
    result = await pending;
    assert.ok(!result.failed && result.insideTranscript && result.moved && result.idleRemoved && result.timerCleared);
    assert.equal(result.animation, 'work-orbit');assert.equal(result.phase, 'reasoning');
    result.passed = true;
  } finally {
    clearTimeout(timer);panel.dispose();
    fs.writeFileSync(path.join(root, '.verification/activity-host.json'), JSON.stringify(result || { passed: false }, null, 2));
  }
};
