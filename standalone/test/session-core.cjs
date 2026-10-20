// All records, paths and protocol replies are synthetic. No editor module may load.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  assert.notEqual(name, 'vscode', 'Session core must load without VS Code');
  return originalLoad.call(this, name, ...args);
};
const { createSessionCore } = require('../runtime/session-core.cjs');
const { AppServer } = require('../runtime/transport.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-core-synthetic-'));
  const values = new Map(), visible = new Set(), events = [];
  const noop = () => {};
  let core;
  class SyntheticTransport extends AppServer {
    constructor(options) {
      super({ ...options, spawnProcess: (_executable, _args, options) =>
        spawn(process.execPath, [path.join(__dirname, 'fake-server.cjs')], options) });
    }
    request(method, ...args) {
      if (method === 'account/read') return Promise.resolve({ account: null });
      if (method === 'model/list') return Promise.resolve({ data: [], nextCursor: null });
      if (method === 'config/read') return Promise.resolve({ config: {} });
      return super.request(method, ...args);
    }
  }
  const host = {
    paths: { storage: root },
    workspaceState: { get: (key, fallback) => values.get(key) ?? fallback,
      update: async (key, value) => { values.set(key, value); } },
    settings: (key, fallback, scope) => {
      assert.equal(scope, 'user');return { features: { synthetic: true } };
    },
    trusted: () => true, logger: noop,
    clock: { now: () => 1234567890, setTimeout, clearTimeout },
    events: { changed: () => events.push('changed'), sessionChanged: s => events.push(s.key),
      treeChanged: noop, notify: noop, completed: noop },
    hasChat: s => visible.has(s.key), isActive: () => true, activeSession: () => core.sessions.values().next().value,
    openChat: noop, loadSelected: noop, defaultDirectory: () => root, editorSelection: () => null,
    activateConnectionOwner: noop, resolveCli: async () => path.join(root, 'synthetic-cli.exe'),
    checkCliUpdates: noop, cliCheckPending: () => true, acceptCli: noop,
    clearProjectFiles: noop, applyPendingMode: async () => {}, taskSessions: () => null,
    createTransport: SyntheticTransport,
  };
  try {
    core = createSessionCore(host);
    const s = core.createSession({ key: 'synthetic-session' });
    assert.equal(s.id, null);assert.equal(s.busy, false);
    assert.equal(Object.hasOwn(s, 'panel'), false);assert.equal(Object.hasOwn(s, 'host'), false);
    s.draft = 'Synthetic draft';await core.save(s);
    assert.equal(core.store.session(s.key).draft, s.draft);
    assert.equal(values.get('session:' + s.key).draft, s.draft);
    const other = createSessionCore(host);
    const loaded = other.createSession({ key: s.key });
    assert.equal(loaded.draft, s.draft);assert.notEqual(other.sessions, core.sessions);
    const connection = core.connect();
    assert.equal(await core.connect(), await connection, 'Concurrent connects share the transport');
    const client = core.state.server;
    assert.equal(client.cwd, root);
    assert.equal((await client.request('test/cwd')).cwd, root);
    assert.deepEqual(await client.request('test/ping'), { ok: true });
    assert.equal(core.state.accountReadRevision, 1);
    assert.equal(core.state.catalogUpdatedAt, 1234567890);
    assert.equal(core.mcpThreadConfig(s), null);
    s.mcpTask = true;assert.deepEqual(core.mcpThreadConfig(s), { features: { synthetic: true } });
    // Both hidden lifecycle branches still use the host's explicit visibility predicate.
    s.id = 'thread-a';s.busy = true;s.turnId = 'synthetic-turn';visible.add(s.key);
    core.notifySessions({ method: 'turn/completed', params: { threadId: s.id,
      turn: { id: 'synthetic-turn', status: 'completed' } } });
    assert.equal(core.sessions.has(s.key), true);
    visible.delete(s.key);s.busy = true;s.turnId = 'synthetic-next-turn';
    core.notifySessions({ method: 'turn/completed', params: { threadId: s.id,
      turn: { id: 'synthetic-next-turn', status: 'completed' } } });
    assert.equal(core.sessions.has(s.key), false);
    assert.ok(events.includes(s.key));
    await core.library.queue;
    console.log('Session core: Node-only record lifecycle, persistence, isolated state, synthetic JSONL connection and visibility passed.');
  } finally {
    const child = core?.state.server?.child;
    const closed = child ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve();
    core?.stopAccountServer();await closed;
    Module._load = originalLoad;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error);process.exitCode = 1; });

