// Read-only demo of the real webview assets. No CLI, credentials or user history.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const extensionRoot = path.resolve(__dirname, '../..');
const scripts = ['translations', 'i18n', 'forms', 'questions', 'question-panel', 'task-preflight', 'icons', 'tabs', 'controls', 'toggles', 'modes', 'speed', 'changes', 'limits', 'limits-view', 'markdown', 'markdown-view', 'messages', 'activity', 'transcript-scroll', 'queued-editor', 'app'];

function demoPage(url) {
  const light = url.searchParams.get('theme') === 'light';
  const questions = url.searchParams.get('scene') === 'questions';
  const lang = questions ? 'ru' : 'en';
  const tokens = {
    'editor-background': light ? '#ffffff' : '#181818',
    'sideBar-background': light ? '#ffffff' : '#181818',
    foreground: light ? '#333333' : '#dddddd',
    descriptionForeground: light ? '#616161' : '#a0a0a0',
    'editorWidget-background': light ? '#f3f3f3' : '#252526',
    'editorWidget-foreground': light ? '#333333' : '#dddddd',
    'input-background': light ? '#ffffff' : '#242424',
    'input-foreground': light ? '#333333' : '#dddddd',
    'input-border': light ? '#cecece' : '#454545',
    'input-placeholderForeground': '#767676',
    'panel-border': light ? '#e5e5e5' : '#383838',
    'widget-border': light ? '#cecece' : '#454545',
    'textBlockQuote-background': light ? '#f2f2f2' : '#222222',
    'button-background': '#0078d4', 'button-foreground': '#ffffff',
    'button-hoverBackground': '#005a9e', 'toolbar-hoverBackground': light ? '#0000000f' : '#ffffff14',
    focusBorder: '#0090f1', 'textLink-foreground': light ? '#006ab1' : '#4daafc',
  };
  const fixture = {
    language: lang, languageChoice: lang, key: 'demo', id: 'demo-thread', hostKey: 'demo-host',
    name: questions ? 'План перед изменениями' : 'A small, testable refactor',
    account: {type: 'chatgpt'}, cli: {version: null, phase: 'ready'},
    model: 'demo-model', effort: 'medium',
    models: [{model: 'demo-model', displayName: 'Codex', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{reasoningEffort: 'low'}, {reasoningEffort: 'medium'}, {reasoningEffort: 'high'}]}],
    prefs: {focus: false, showThinking: true, ide: true, access: 'workspace', controlMotion: 'off', activityMotion: 'off'},
    chatWidth: 'compact', contextDisplay: 'percent',
    tokenUsage: {last: {totalTokens: 12000}, modelContextWindow: 100000}, usageModel: 'demo-model',
    limits: {buckets: []}, attachments: [], followUps: [], requests: [], bookmarks: [], questionHistory: [],
    draft: questions ? '' : 'Add tests for empty input and duplicate tags.',
    items: questions ? [
      {id: 'user', type: 'userMessage', text: 'Помоги добавить поиск по заметкам. Сначала обсудим план, потом изменим код.'},
      {id: 'answer', type: 'agentMessage', text: 'Начнём с небольшого изменения.\n\n1. Добавим поле поиска и фильтрацию по заголовку.\n2. Сохраним выбранную заметку при обновлении списка.\n3. Проверим пустой запрос и отсутствие результатов.\n\nПеред реализацией уточним поведение поиска.'},
    ] : [
      {id: 'user', type: 'userMessage', text: 'Extract tag normalization into a small TypeScript function. Keep it easy to test.'},
      {id: 'answer', type: 'agentMessage', text: '### Normalize once, reuse everywhere\n\nA pure function keeps validation separate from the interface. It trims whitespace, removes empty values and preserves the first occurrence of each tag.\n\n```typescript\nexport function normalizeTags(tags: readonly string[]): string[] {\n  const trimmed = tags.map(tag => tag.trim());\n  return [...new Set(trimmed.filter(Boolean))];\n}\n```\n\nFor example, `[" docs ", "", "docs", "api"]` becomes `["docs", "api"]`.\n\n- **Predictable:** the input array stays unchanged.\n- **Reusable:** the same function works in forms and imports.\n- **Testable:** no UI or network dependencies.\n\nNext, cover whitespace-only input and duplicate tags with focused tests.'},
    ],
  };
  if (questions) fixture.requests = [{id: 'demo-question', method: 'item/tool/requestUserInput', params: {threadId: 'demo-thread', questions: [{id: 'search', header: 'Поиск', question: 'По каким данным искать заметки?', options: [{label: 'Только заголовки (Рекомендую)', description: 'Простой поиск без изменений содержимого заметок.'}, {label: 'Заголовки и текст', description: 'Более широкий поиск по содержимому.'}]}]}}];
  const style = Object.entries(tokens).map(([key, value]) => `--vscode-${key}:${value}`).join(';');
  return `<!doctype html><html lang="${lang}" data-language="${lang}" data-ui-version="${require('../../package.json').version}" style="${style};color-scheme:${light ? 'light' : 'dark'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rundix — demo screenshots</title><link rel="stylesheet" href="/ui/app.css"></head><body><main id="app" style="width:min(100%,900px);height:720px"></main><script>
  const fixture = ${JSON.stringify(fixture).replace(/</g, '\\u003c')};
  const publish = () => window.dispatchEvent(new MessageEvent('message', {data:{type:'state',data:fixture}}));
  window.acquireVsCodeApi = () => ({getState:()=>({}),setState:()=>{},postMessage:message=>{
    if(message.action==='draft')fixture.draft=message.text;
    if(message.action==='mode')fixture.prefs.pendingMode=message.mode;
    if(message.action==='preferences')Object.assign(fixture.prefs,message);
    queueMicrotask(publish);
  }});
  </script>${scripts.map(name => `<script src="/ui/${name}.js"></script>`).join('')}</body></html>`;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
    response.end(demoPage(url));
    return;
  }
  if (!/^\/ui\/[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)) {
    response.writeHead(404); response.end(); return;
  }
  const asset = path.join(extensionRoot, url.pathname.slice(1));
  fs.readFile(asset, (error, content) => {
    response.writeHead(error ? 404 : 200, {'Content-Type': url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript'});
    response.end(error ? '' : content);
  });
});
server.listen(0, '127.0.0.1', () => console.log(`Screenshot preview: http://127.0.0.1:${server.address().port}`));
