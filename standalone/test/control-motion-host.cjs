const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

exports.run = async () => {
  const root = path.resolve(__dirname, '..');
  const panel = vscode.window.createWebviewPanel('motionFixture', 'Control motion fixture',
    vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [vscode.Uri.file(root)] });
  const fixture = {
    key: 'motion-fixture', id: 'synthetic-thread', model: 'fixture', effort: 'low', controlMotion: 'on',
    models: [{ model: 'fixture', displayName: 'Fixture', defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        .map(reasoningEffort => ({ reasoningEffort })), serviceTiers: [{ id: 'priority' }] }],
    prefs: { access: 'workspace', fast: false }, items: [], requests: [], attachments: [],
  };
  const scripts = ['translations', 'i18n', 'forms', 'questions', 'question-panel', 'task-preflight',
    'icons', 'tabs', 'controls', 'toggles', 'modes', 'speed', 'changes', 'limits', 'limits-view',
    'markdown', 'markdown-view', 'messages', 'activity', 'transcript-scroll', 'queued-editor', 'app'];
  const uri = file => panel.webview.asWebviewUri(vscode.Uri.file(path.join(root, 'ui', file)));
  let timer;
  const result = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error('Motion webview probe timed out')), 20000);
    panel.webview.onDidReceiveMessage(message => {
      if (message.action === 'ready') panel.webview.postMessage({ type: 'state', data: fixture });
      if (message.action === 'motionResult') resolve(message.report);
    });
  });
  panel.webview.html = `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-motion'; img-src ${panel.webview.cspSource} data:;">
    <link rel="stylesheet" href="${uri('app.css')}"></head><body><main id="app"></main>
    <script nonce="motion">window.motionApi = acquireVsCodeApi(); window.acquireVsCodeApi = () => window.motionApi;</script>
    ${scripts.map(name => `<script nonce="motion" src="${uri(name + '.js')}"></script>`).join('')}
    <script nonce="motion">
    (async () => {
      try {
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        while (!document.querySelector('.model-button')) await frame();
        await frame(); await frame();
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', data: ${JSON.stringify(fixture)} } }));
        document.querySelector('.model-button').click();
        await frame(); await frame();
        const range = document.querySelector('input[type=range]');
        const thumb = document.querySelector('.reasoning-thumb');
        const start = thumb.getBoundingClientRect().x;
        range.value = 1;
        range.dispatchEvent(new Event('input'));
        const positions = [];
        const began = performance.now();
        while (performance.now() - began < 400) {
          positions.push({ ms: performance.now() - began, x: thumb.getBoundingClientRect().x });
          await frame();
        }
        window.motionApi.postMessage({ action: 'motionResult', report: {
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          transition: getComputedStyle(thumb).transition, start, positions,
        } });
      } catch (error) { window.motionApi.postMessage({ action: 'motionResult', report: { error: error.message } }); }
    })();
    </script></body></html>`;
  try {
    const report = await result;
    assert.ok(!report.error, report.error);
    const end = report.positions.at(-1).x;
    const distance = end - report.start;
    report.firstPixelMs = report.positions.find(item => item.x >= report.start + 1)?.ms ?? null;
    const travel = report.positions.filter(item => item.x > report.start + distance * 0.15 && item.x < report.start + distance * 0.85);
    report.intermediateFrames = travel.length;
    report.visibleTravelMs = travel.length ? travel.at(-1).ms - travel[0].ms : 0;
    report.passed = distance > 11 && travel.length >= 5 && report.visibleTravelMs >= 65;
    fs.mkdirSync(path.join(root, '.verification'), { recursive: true });
    fs.writeFileSync(path.join(root, '.verification/control-motion-host.json'), JSON.stringify(report, null, 2));
    console.log('Motion webview:', JSON.stringify(report));
    assert.ok(end > report.start + 11, 'Thumb must reach the adjacent stop');
    assert.ok(report.passed, 'Explicit motion must remain visible across real frames, including reduced motion');
  } finally {
    clearTimeout(timer);
    panel.dispose();
  }
};
