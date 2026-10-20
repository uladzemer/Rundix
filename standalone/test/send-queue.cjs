// All sessions, messages, paths and server replies in this file are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { AppServer } = require('../runtime/transport.cjs');
const { notification } = require('../runtime/session.cjs');
const { acquireQueuedSession } = require('../runtime/queued-session-transfer.cjs');
const { assertQueueCurrent } = require('../runtime/queued-edits.cjs');
const source = fs.readFileSync(path.join(__dirname, '../extension.cjs'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const uncertain = () => Object.assign(Error('Synthetic lost reply'), { deliveryUncertain: true });

function extract(startText, endText) {
  const start = source.indexOf(startText), end = source.indexOf(endText, start);
  assert(start >= 0 && end > start, startText);
  return source.slice(start, end);
}

function fixture() {
  const leases = new Set(), records = new Map(), calls = [], diagnostics = [];
  let sequence = 0, diskFailure = false, cacheUpdate = async () => {};
  const s = { key: 'synthetic-session', id: 'synthetic-thread', cwd: 'synthetic-project',
    loaded: true, busy: false, model: 'synthetic-model', prefs: {}, items: [],
    draft: 'Synthetic input', attachments: [], followUps: [], panel: {} };
  const server = new EventEmitter();
  let start = async () => { throw uncertain(); };
  let list = async () => { throw Error('Synthetic unavailable reconciliation'); };
  server.request = async (method, params, timeout) => {
    calls.push({ method, params, timeout });
    if (method === 'turn/start') return start();
    if (method === 'thread/turns/list') return list();
    throw Error('Unexpected synthetic request');
  };
  const acquire = id => {
    assert(!leases.has(id), 'Synthetic conflicting lease: ' + id);
    leases.add(id);
    return () => leases.delete(id);
  };
  const noop = async () => {};
  const context = vm.createContext({
    authBusy: false, accountReadRevision: 1, activeConnection: {}, account: {},
    limits: { updatedAt: 1 }, limitsRequest: null, catalogUpdatedAt: Date.now(),
    catalog: [{ model: s.model, supportedReasoningEfforts: [] }],
    store: { acquire, session: key => records.get(key), saveSession(record) {
      if (diskFailure) throw Error('Synthetic atomic write failure');
      const written = clone(record);records.set(s.key, written);return written;
    } },
    context: { workspaceState: { update: (...args) => cacheUpdate(...args) } },
    taskDirectory: { canonical: value => value, acquire: () => acquire('synthetic-directory') },
    cwd: () => s.cwd, locale: { t: text => text }, vscode: { workspace: { isTrusted: true } },
    syncExternal: noop, applyPendingMode: noop, connect: noop, refreshAccount: async () => false,
    refreshLimits: noop, refreshCatalog: noop, connections: { assertCurrent() {} },
    updateDraftModel() {}, resume: noop, preflight: { preparing: () => false },
    modes: { current: () => ({ id: 'workspace' }), policy: () => ({}) },
    speed: { effectiveTier: () => 'default' }, buildInput: text => [{ type: 'text', text }],
    require: id => { assert.equal(id, './ui/limits.js');return { exhaustion: () => null }; },
    server, turnLeases: new Map(), publish() {}, randomUUID: () => 'synthetic-queued-' + ++sequence,
    acquireQueuedSession, assertQueueCurrent, output: { appendLine: text => diagnostics.push(text) },
    setTimeout, notification, sessions: new Map([[s.key, s]]),
    captureCompletion() {}, completionNotifications: { dispatch() {} },
    isActive: () => true, treeEvents: { fire() {} },
  });
  for (const [name, next] of [['save', 'function html'], ['send', 'async function preparationConfig'],
    ['queueFollowUp', 'async function steer'], ['drainFollowUps', 'async function applyPendingMode']]) {
    context[name] = vm.runInContext('(' + extract('  async function ' + name + '(', '  ' + next).trim() + ')', context);
  }
  const notificationStart = source.indexOf('        for (const s of sessions.values()) {', source.indexOf('const completion = captureCompletion') - 100);
  const notificationEnd = source.indexOf('        treeEvents.fire();', notificationStart);
  assert(notificationStart >= 0 && notificationEnd > notificationStart);
  server.on('notification', vm.runInContext('(message)=>{' + source.slice(notificationStart, notificationEnd) + '}', context));
  // Use the real host disconnect cleanup, before the per-send listener.
  const disconnected = extract('      server.on("disconnected", (message) => {', '      server.on("protocolError"');
  Object.assign(context, { notificationServer: context.server, pendingLogin: { current: null, finish() {} }, connecting: null, limitsEpoch: 0, pendingRequests: new Map(), output: {
    appendLine: text => diagnostics.push(text),
  } });
  vm.runInContext(disconnected, context);
  const emit = (method, id = 'synthetic-turn', status = 'completed', threadId = s.id) =>
    server.emit('notification', { method, params: { threadId, turn: { id, status } } });
  return { s, server, context, leases, calls, records, diagnostics, emit,
    start: fn => { start = fn; }, list: fn => { list = fn; },
    failDisk: value => { diskFailure = value; }, cache: fn => { cacheUpdate = fn; },
    assertOwned() {
      assert.equal(s.busy, true);assert(leases.has(s.id));assert(leases.has('synthetic-directory'));
      assert(context.turnLeases.has(s.id));assert(!leases.has('account-credentials'));
    },
    assertReleased() {
      assert.equal(s.busy, false);assert(!leases.has(s.id));assert(!leases.has('synthetic-directory'));
      assert(!context.turnLeases.has(s.id));
    },
  };
}

async function transportChecks() {
  const server = new AppServer();let written;
  server.child = { stdin: { writable: true, write: text => { written = JSON.parse(text); } } };
  await assert.rejects(server.request('turn/start', {}, 5), error => error.deliveryUncertain === true);
  server.receive({ id: written.id, result: { turn: { id: 'synthetic-late-turn' } } });
  assert.equal(server.pending.size, 0, 'Late response cannot resolve or replay a timed-out request');
  const rejected = server.request('turn/start');
  server.receive({ id: written.id, error: { message: 'Synthetic refusal' } });
  await assert.rejects(rejected, error => error.deliveryUncertain === false);
  const lost = server.request('turn/start');server.fail(Error('Synthetic disconnect'));
  await assert.rejects(lost, error => error.deliveryUncertain === true);
  server.child = null;
  await assert.rejects(server.request('turn/start'), error => error.deliveryUncertain === false);
}

async function sendChecks() {
  // Started notification already arrived when the reply times out.
  let f = fixture();
  f.start(async () => { f.emit('turn/started');throw uncertain(); });
  await assert.rejects(f.context.send(f.s, 'Synthetic input'));
  f.assertOwned();assert.equal(f.s.turnId, 'synthetic-turn');
  assert.equal(f.calls.length, 1, 'Known running turn needs no query or resend');
  f.server.emit('disconnected', 'Synthetic disconnect after timeout');f.assertReleased();
  f.emit('turn/completed');f.assertReleased();

  // No notification: bounded query finds a running turn.
  f = fixture();f.list(async () => ({ data: [{ id: 'synthetic-turn', status: 'inProgress' }] }));
  await assert.rejects(f.context.send(f.s, 'Synthetic input'));
  f.assertOwned();assert.equal(f.calls[1].timeout, 5000);assert.equal(f.s.turnId, 'synthetic-turn');
  f.server.emit('disconnected', 'Synthetic disconnect after reconciliation');f.assertReleased();
  f.emit('turn/completed');f.assertReleased();

  // Failed check retains ownership; unrelated thread notifications cannot reconcile it.
  f = fixture();await assert.rejects(f.context.send(f.s, 'Synthetic input'));
  f.assertOwned();f.emit('turn/completed', 'synthetic-other-turn', 'completed', 'synthetic-other-thread');
  f.assertOwned();f.emit('turn/started');f.assertOwned();f.emit('turn/completed');f.assertReleased();

  // A completion arriving while the query is pending wins over its stale running reply.
  f = fixture();let resolveList;
  f.list(() => new Promise(resolve => { resolveList = resolve; }));
  const sending = f.context.send(f.s, 'Synthetic input');await tick();
  f.emit('turn/completed');f.assertReleased();
  resolveList({ data: [{ id: 'synthetic-turn', status: 'inProgress' }] });
  await assert.rejects(sending);f.assertReleased();

  // A started notification wins over a stale empty reply.
  f = fixture();f.list(() => new Promise(resolve => { resolveList = resolve; }));
  const starting = f.context.send(f.s, 'Synthetic input');await tick();
  f.emit('turn/started');resolveList({ data: [] });
  await assert.rejects(starting);f.assertOwned();f.emit('turn/completed');f.assertReleased();

  // Successful ordered check confirms absence; malformed checks cannot unlock.
  for (const data of [[], [{ id: 'synthetic-old-turn', status: 'completed' }]]) {
    f = fixture();f.list(async () => ({ data }));
    await assert.rejects(f.context.send(f.s, 'Synthetic input'));f.assertReleased();
    assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  }
  f = fixture();f.list(async () => ({}));
  await assert.rejects(f.context.send(f.s, 'Synthetic input'));f.assertOwned();
  f.emit('turn/completed');f.assertReleased();

  // A host disconnect means the Codex process is gone: the chat is freed, and the rejection stays deliveryUncertain.
  f = fixture();f.start(async () => { f.server.emit('disconnected', 'Synthetic disconnect');throw uncertain(); });
  await assert.rejects(f.context.send(f.s, 'Synthetic input'));f.assertReleased();
  f.emit('turn/completed');f.assertReleased();

  // Even after turn/started, a disconnect ends the turn with the process.
  f = fixture();f.start(async () => {
    f.emit('turn/started');f.server.emit('disconnected', 'Synthetic disconnect');throw uncertain();
  });
  await assert.rejects(f.context.send(f.s, 'Synthetic input'));f.assertReleased();
  f.emit('turn/completed');f.assertReleased();

  // A replacement server's state must not be overwritten by an old query reply.
  f = fixture();f.list(() => new Promise(resolve => { resolveList = resolve; }));
  const replaced = f.context.send(f.s, 'Synthetic input');await tick();
  f.context.server = new EventEmitter();f.s.turnId = 'synthetic-replacement-turn';
  resolveList({ data: [] });await assert.rejects(replaced);
  assert.equal(f.s.turnId, 'synthetic-replacement-turn');f.assertOwned();
  f.context.server = f.server;f.emit('turn/completed');f.assertReleased();

  // Definite refusal releases; fast completion before a lost reply stays completed.
  f = fixture();f.start(async () => { throw Object.assign(Error('Synthetic refusal'), { deliveryUncertain: false }); });
  await assert.rejects(f.context.send(f.s, 'Synthetic input'));f.assertReleased();assert.equal(f.calls.length, 1);
  f = fixture();f.start(async () => { f.emit('turn/started');f.emit('turn/completed');throw uncertain(); });
  await assert.rejects(f.context.send(f.s, 'Synthetic input'));f.assertReleased();assert.equal(f.calls.length, 1);
}

async function queueChecks() {
  let f = fixture();
  const attachment = { id: 'synthetic-file', kind: 'file', path: 'synthetic/file.cjs' };
  f.s.attachments = [attachment];
  const attachments = f.s.attachments, queue = f.s.followUps;
  f.failDisk(true);
  await assert.rejects(f.context.queueFollowUp(f.s, f.s.draft, [...attachments]), /Synthetic atomic write failure/);
  assert.equal(f.s.followUps, queue);assert.equal(f.s.followUps.length, 0);
  assert.equal(f.s.attachments, attachments);assert.equal(f.s.draft, 'Synthetic input');
  f.failDisk(false);await f.context.queueFollowUp(f.s, f.s.draft, [...attachments]);
  assert.equal(f.s.followUps.length, 1);assert.equal(f.s.attachments.length, 0);assert.equal(f.s.draft, '');
  assert.equal(f.records.get(f.s.key).followUps.length, 1);

  // Pending cache writes cannot expose an uncommitted in-memory queue or lose the composer.
  f = fixture();f.s.attachments = [attachment];let finish;
  f.cache(() => new Promise(resolve => { finish = resolve; }));
  const enqueuing = f.context.queueFollowUp(f.s, f.s.draft, [attachment]);await tick();
  assert.equal(f.s.followUps.length, 0);assert.equal(f.s.attachments.length, 1);assert.equal(f.s.draft, 'Synthetic input');
  await assert.rejects(f.context.queueFollowUp(f.s, 'Synthetic concurrent input', []));
  finish();await enqueuing;assert.equal(f.s.followUps.length, 1);
  f.cache(async () => { throw Error('Synthetic cache failure'); });
  await f.context.queueFollowUp(f.s, 'Synthetic second input', []);
  assert.equal(f.s.followUps.length, 2, 'Durable local write succeeds despite cache failure');
  assert.deepEqual(f.diagnostics, ['[queue] workspace-state-update-failed']);

  // An in-flight drain cannot overwrite or resurrect an enqueue snapshot.
  for (const lostReply of [false, true]) {
    f = fixture();await f.context.queueFollowUp(f.s, f.s.draft, []);
    let finishStart;
    f.start(() => new Promise((resolve, reject) => {
      finishStart = () => lostReply ? reject(uncertain()) : resolve({ turn: { id: 'synthetic-turn' } });
    }));
    const draining = f.context.drainFollowUps(f.s);
    // Attach immediately so the intentional rejection is always observed.
    const drained = lostReply ? assert.rejects(draining) : draining;
    await tick();
    let finishCache;
    f.cache(() => new Promise(resolve => { finishCache = resolve; }));
    const adding = f.context.queueFollowUp(f.s, 'Synthetic concurrent follow-up', []);
    await tick();f.cache(async () => {});finishStart();await tick();
    finishCache();await adding;await drained;
    const expected = lostReply ? ['Synthetic input', 'Synthetic concurrent follow-up'] : ['Synthetic concurrent follow-up'];
    assert.deepEqual(Array.from(f.s.followUps, row => row.text), expected);
    assert.deepEqual(f.records.get(f.s.key).followUps.map(row => row.text), expected);
    if (lostReply) assert.equal(f.records.get(f.s.key).followUps[0].deliveryUncertain, true);
    f.emit('turn/completed', 'synthetic-turn', 'interrupted');await tick();f.assertReleased();
  }

  // Uncertain queued starts are durable and blocked after completion and manual drain.
  for (const started of [false, true]) {
    f = fixture();await f.context.queueFollowUp(f.s, f.s.draft, []);
    if (started) f.start(async () => { f.emit('turn/started');throw uncertain(); });
    await assert.rejects(f.context.drainFollowUps(f.s));f.assertOwned();
    assert.equal(f.s.followUps[0].deliveryUncertain, true);
    assert.equal(f.records.get(f.s.key).followUps[0].deliveryUncertain, true);
    f.emit('turn/completed');await tick();f.assertReleased();
    f.s.error = null;
    await assert.rejects(f.context.drainFollowUps(f.s, { manual: true }));
    assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(f.s.followUps.length, 1);
  }
}

(async () => {
  await transportChecks();await sendChecks();await queueChecks();
  console.log('Send/queue: uncertain start reconciliation and leases, no follow-up replay, transactional enqueue passed.');
})().catch(error => { console.error(error);process.exitCode = 1; });
