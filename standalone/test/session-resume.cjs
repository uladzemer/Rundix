// Synthetic only: delayed RPC replies never touch a CLI or account credentials.
const assert = require('node:assert/strict');
const { resume, resumeThread } = require('../runtime/session-resume.cjs');

async function switchedDuring(blockedMethod, change) {
  let release;
  const requests = [];
  const s = { id: 'synthetic-thread', loaded: false, prefs: {}, items: [],
    draft: 'Synthetic unsent draft', model: 'synthetic-selected-model' };
  const response = method => method === 'thread/resume'
    ? { thread: { name: 'Synthetic restored thread', status: { type: 'idle' } }, model: 'synthetic-restored-model' }
    : { data: [] };
  const server = { request: async method => {
    requests.push(method);
    if (method === blockedMethod) await new Promise(resolve => { release = resolve; });
    return response(method);
  } };
  let saves = 0, publishes = 0;
  const deps = { server, limitsEpoch: 1, threadReleases: new Map(), connect: async () => {}, sessions: new Map(),
    mcpThreadConfig: () => null, readItem: item => item, questionRecords: { restore() {} },
    save: async () => { saves++; }, publish() { publishes++; } };
  deps.resumeThread = (...args) => resumeThread(deps, ...args);
  const pending = resume(deps, s, s.id);
  while (!release) await new Promise(setImmediate);
  if (change === 'server') deps.server = { request() { throw Error('Must not use replacement before resume'); } };
  if (change === 'account') deps.limitsEpoch++;
  if (change === 'chat') s.id = 'synthetic-other-thread';
  release();
  await assert.rejects(pending, { code: 'STALE_SESSION_RESUME' });
  assert.equal(s.loaded, false);
  assert.equal(s.model, 'synthetic-selected-model');
  assert.equal(s.draft, 'Synthetic unsent draft');
  assert.deepEqual(s.items, []);
  assert.equal(s.loading, null);
  assert.equal(saves, 0); assert.equal(publishes, 0);
  assert.equal(requests.at(-1), blockedMethod, 'No further requests after ownership changes');
  if (change !== 'chat') {
    deps.server = { request: async method => response(method) };
    await resume(deps, s, s.id);
    assert.equal(s.loaded, true, 'A fresh attempt can restore the thread after switching');
    assert.equal(s.model, 'synthetic-restored-model');
    assert.equal(saves, 1); assert.equal(publishes, 1);
  }
}

async function beforeRead(stage) {
  let release;
  const s = { id: 'synthetic-thread', loaded: false, prefs: {}, items: [] };
  const deps = { threadReleases: new Map(), sessions: new Map(), limitsEpoch: 1,
    connect: async () => {}, mcpThreadConfig: () => null,
    server: { request() { throw Error('Stale restoration must not issue any RPC'); } } };
  const wait = () => new Promise(resolve => { release = resolve; });
  if (stage === 'connect') deps.connect = wait;
  else { s.preflight = { enabled: true }; deps.preparationConfig = wait; deps.preflight = { preparing: () => false }; }
  const pending = resumeThread(deps, s, s.id);
  while (!release) await new Promise(setImmediate);
  if (stage === 'connect') s.id = 'synthetic-other-thread';
  else deps.limitsEpoch++;
  release({});
  await assert.rejects(pending, { code: 'STALE_SESSION_RESUME' });
  assert.equal(s.loaded, false);
}

(async () => {
  for (const method of ['thread/resume', 'thread/turns/list', 'thread/items/list'])
    for (const change of ['server', 'account', 'chat']) await switchedDuring(method, change);
  await beforeRead('connect');
  await beforeRead('configuration');
  console.log('session-resume: synthetic connection/account/chat ownership checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
