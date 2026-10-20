const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {runService} = require('../runtime/service-main.cjs');
const {connectService} = require('../runtime/service-endpoint.cjs');
const {fixture} = require('./service-fixture.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-space-rpc-synthetic-'));
  const data = fixture(root), peers = []; let service;
  const a = path.join(root, 'a'), b = path.join(root, 'b'); fs.mkdirSync(a); fs.mkdirSync(b);
  const connect = async directory => {const peer = await connectService({root, hello:{clientKind:'adapter', binding:{launchDirectory:directory, source:'cwd'}}}); peers.push(peer); return peer;};
  const call = async (peer, name, args = {}) => {
    const value = await peer.call('task.call', {bindingId:peer.binding.bindingId, spaceId:peer.binding.spaceId, name, arguments:args}, 20000);
    if (value.error) throw Object.assign(Error(value.error.message), value.error); return value.result;
  };
  try {
    service = await runService({root, hostOptions:data.hostOptions, pollerOptions:{pollMs:20}});
    const pa = await connect(a), pb = await connect(b);
    assert.notEqual(pa.binding.spaceId, pb.binding.spaceId);
    const ta = await call(pa, 'submit_task', {requestId:'synthetic-shared-request', description:'Synthetic A', acceptanceCriteria:'Synthetic check', projectDirectory:b});
    const tb = await call(pb, 'submit_task', {requestId:'synthetic-shared-request', description:'Synthetic B', acceptanceCriteria:'Synthetic check', projectDirectory:a});
    assert.notEqual(ta.taskId, tb.taskId);
    assert.equal((await call(pa, 'list_tasks')).tasks.length, 1);
    assert.equal((await call(pb, 'list_tasks')).tasks[0].taskId, tb.taskId);
    for (const name of ['get_task', 'wait_task', 'continue_task', 'cancel_task', 'close_task'])
      await assert.rejects(call(pa, name, {taskId:tb.taskId, requestId:'synthetic-shared-request', clarification:'Synthetic foreign'}), {code:'unknown_task'});
    await assert.rejects(call(pa, 'wait_tasks', {taskIds:[ta.taskId, tb.taskId], waitSeconds:1}), {code:'unknown_task'});
    const bad = await pa.call('task.call', {bindingId:pa.binding.bindingId, spaceId:pb.binding.spaceId, name:'list_tasks', arguments:{}});
    assert.equal(bad.error.code, 'space_not_bound');
    for (const [peer, task] of [[pa, ta], [pb, tb]]) {
      let result;
      for (let attempt = 0; attempt < 10; attempt++) {
        result = await call(peer, 'wait_task', {taskId:task.taskId, waitSeconds:1}); if (!result.timedOut) break;
      }
      assert.equal(result.state, 'completed');
    }
    const hiddenConfig = data.installed.configPath + '.synthetic-hidden'; fs.renameSync(data.installed.configPath, hiddenConfig);
    await assert.rejects(call(pa, 'submit_task', {requestId:'synthetic-no-provider', description:'Synthetic task', acceptanceCriteria:'Synthetic check', projectDirectory:a}),
      {code:'action_required', providerCode:'PROVIDER_NOT_CONFIGURED'});
    fs.renameSync(hiddenConfig, data.installed.configPath);
    await service.host.provider.configureByClient({clientId:'synthetic-client', operationId:'synthetic-wait-config', expectedSelectionRevision:1, action:'synthetic', payload:{scenario:'scan-wait'}});
    const waiting = await call(pa, 'submit_task', {requestId:'synthetic-limit', description:'Synthetic limited task', acceptanceCriteria:'Synthetic check', projectDirectory:a});
    const started = Date.now();
    const checkpoint = await call(pa, 'wait_task', {taskId:waiting.taskId, waitSeconds:1});
    assert.equal(checkpoint.state, 'waiting_limit'); assert(checkpoint.timedOut); assert(Date.now() - started >= 900);
    assert(checkpoint.waitingLimit.resetAt > Date.now()); assert.equal(service.host.provider.activeTurns, 0);
    assert(fs.readdirSync(path.join(root, 'sessions-v1')).some(name => name.startsWith('task-directory-')), 'Waiting retains directory reservation');
    const resumed = await connect(a);
    assert.equal((await call(resumed, 'get_task', {taskId:waiting.taskId})).state, 'waiting_limit');
    const mixed = await call(pa, 'wait_tasks', {taskIds:[waiting.taskId], waitSeconds:1});
    assert(mixed.timedOut); assert.equal(mixed.settled.length, 0); assert.equal(mixed.waitingLimits.length, 1);
    const waiter = call(resumed, 'wait_task', {taskId:waiting.taskId, waitSeconds:10}).catch(() => null);
    await pause(30); resumed.close(); await waiter; await pause(30);
    assert.equal(service.host.mcp.tasks.waiters.size, 0, 'Disconnect removes long-poll waiter');
    assert.equal((await call(pa, 'cancel_task', {taskId:waiting.taskId, requestId:'synthetic-cancel-limit'})).state, 'cancelled');
    assert.equal((await call(pa, 'close_task', {taskId:waiting.taskId})).chatClosed, false);
    await service.host.provider.configureByClient({clientId:'synthetic-client', operationId:'synthetic-ready-config', expectedSelectionRevision:2, action:'synthetic', payload:{scenario:'ready'}});
    await call(pa, 'continue_task', {taskId:waiting.taskId, requestId:'synthetic-after-cancel', clarification:'Synthetic fresh execution'});
    const fresh = await call(pa, 'wait_task', {taskId:waiting.taskId, waitSeconds:2});
    assert.equal(fresh.state, 'completed', 'Continuing after cancelled limit wait uses a fresh wait identity');
    let selection = 3;
    for (const code of ['LIMITS_UNKNOWN','RESET_UNKNOWN','BUSY_ACTIVE','AUTH_REQUIRED','AUTH_REVOKED','STORE_UNAVAILABLE','CLIENT_REQUIRED','PLATFORM_UNSUPPORTED','PROVIDER_PROCESS_UNCERTAIN','MIRROR_BUSY']) {
      await service.host.provider.configureByClient({clientId:'synthetic-client', operationId:'synthetic-map-' + code, expectedSelectionRevision:selection++, action:'synthetic', payload:{scenario:'scan-' + code}});
      await service.host.provider.authenticate();
      const task = await call(pa, 'submit_task', {requestId:'synthetic-map-' + code, description:'Synthetic mapping', acceptanceCriteria:'Synthetic checks', projectDirectory:a});
      const value = await call(pa, 'wait_task', {taskId:task.taskId, waitSeconds:1});
      const reason = {LIMITS_UNKNOWN:'limits_unknown', RESET_UNKNOWN:'reset_unknown', BUSY_ACTIVE:'active_turns'}[code];
      if (reason) {
        assert.equal(value.state, 'waiting_limit');assert(value.timedOut);assert.deepEqual(value.waitingLimit, {resetAt:null, reason});
        await call(pa, 'cancel_task', {taskId:task.taskId, requestId:'synthetic-cancel-' + code});
      } else {
        assert.equal(value.state, 'error');assert(!value.timedOut);assert.match(value.error, /action_required/);assert.equal(value.recoveryRequired, false);
      }
      assert.equal(service.host.provider.activeTurns, 0);
    }
    for (const peer of peers) peer.close(); await pause(30);
    assert.equal((await service.dispose()).exiting, true); service = null;
    console.log('PASS space task RPC: real IPC bindings, cross-repo execution, per-space replay, foreign IDs, limit non-wake, wait snapshots, cancellation and disconnect cleanup.');
  } finally {
    for (const peer of peers) peer.close();
    try {await service?.dispose();} catch {} await service?.endpoint.dispose(); await data.close();
    assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith('rundix-space-rpc-synthetic-'));
    fs.rmSync(root, {recursive:true, force:true});
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
