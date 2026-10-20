const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {ServiceProvider} = require('../runtime/service-provider.cjs');
const {ServiceAppServer} = require('../runtime/service-cli.cjs');
const {install} = require('./service-provider-fixture.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-provider-synthetic-'));
  const children = [], providers = [];
  const launch = (executable, args, options) => {
    const child = spawn(executable, args, options); children.push({child, closed:once(child, 'close')}); return child;
  };
  async function create(name, options={}) {
    const directory = path.join(root, name); fs.mkdirSync(directory);
    const {configPath} = install(directory);
    const provider = new ServiceProvider({serviceGeneration:'synthetic-service', configPath, verifyPrivate:() => {},
      ...options, spawnProcess:launch, createCli:options => new ServiceAppServer({...options, executable:process.execPath, cwd:directory,
        env:{...process.env, CODEX_HOME:directory}, spawnProcess:(_exe, _argv, opts) => launch(process.execPath, [path.join(__dirname, 'fake-service-cli.cjs')], opts)})});
    providers.push(provider); const before=children.length;await Promise.all([provider.start(),provider.start()]);assert.equal(children.length,before+1,'Concurrent startup shares validation and child'); const cli = provider.createCli(); await cli.start();
    let selection = 1;
    return {provider, cli, directory, configure:scenario => provider.configureByClient({clientId:'synthetic-client', operationId:'synthetic-operation',
      expectedSelectionRevision:selection++, action:'synthetic', payload:{scenario}})};
  }
  const task = (id, waitId) => ({taskId:id, spaceId:'synthetic-space', attemptId:'synthetic-attempt-' + id, runId:'synthetic-run-' + id, ...(waitId ? {waitId} : {})});
  try {
    const explicit=await create('explicit-recovery',{recoveryBackoffMs:10000});await explicit.provider.authenticate();
    const previousGeneration=explicit.provider.authority.providerGeneration;
    const disconnected=once(explicit.provider,'connectionChanged');children.at(-2).child.kill();await disconnected;
    const began=Date.now();await explicit.provider.start();assert(Date.now()-began<8000,'Explicit recovery bypasses the scheduled ten-second backoff');
    assert.notEqual(explicit.provider.authority.providerGeneration,previousGeneration);await explicit.provider.dispose();
    const crashing=await create('crash-after-hello',{recoveryBackoffMs:10,now:()=>0});
    for(let cycle=0;cycle<6;cycle++){
      const generation=crashing.provider.authority.providerGeneration;
      children.findLast(row=>row.child.spawnargs.some(arg=>arg.endsWith('provider-entry.cjs'))).child.kill();
      if(cycle<5){
        const deadline=Date.now()+5000;let recovered=false;
        while(Date.now()<deadline){try{if(crashing.provider.authority.providerGeneration!==generation){await crashing.provider.status();recovered=true;break;}}catch{}await pause(10);}
        assert(recovered,'A consecutive failure within the retry budget restarts automatically');
      }else{await pause(600);assert.equal(crashing.provider.authority.providerGeneration,generation,'Hello alone cannot replenish the crash-loop budget');}
    }
    await crashing.provider.dispose();
    const lateDir=path.join(root,'late-disposal');fs.mkdirSync(lateDir);const lateConfig=install(lateDir);
    let lateSpawn=0;
    const late=new ServiceProvider({serviceGeneration:'synthetic-late',configPath:lateConfig.configPath,verifyPrivate:()=>{},spawnProcess(){lateSpawn++;throw Error('Disposed provider must not launch');}});
    const pendingStart=late.start();await late.dispose();await assert.rejects(pendingStart,{reason:'action_required'});assert.equal(lateSpawn,0);
    await assert.rejects(new ServiceProvider({serviceGeneration:'synthetic-service', configPath:path.join(root, 'missing.json')}).start(), {code:'PROVIDER_NOT_CONFIGURED', reason:'action_required'});
    const {provider, cli, configure} = await create('normal');
    await assert.rejects(cli.request('turn/start'), {code:'connection_unavailable'});
    await provider.authenticate(); assert(cli.authenticated); assert.equal(provider.accountGrant.binding.accountRevision, 1);
    await assert.rejects(cli.request('turn/start', {threadId:'unadmitted'}), {code:'STALE_FENCE'});
    await assert.rejects(cli.request('turn/steer', {threadId:'unadmitted'}), {code:'STALE_FENCE'});
    const probe = await provider.prepareTurn(task('probe'), {mode:'probe'}); assert.equal(probe.kind, 'ready'); assert.equal(provider.activeTurns, 0);
    const ready = await provider.prepareTurn(task('a')); assert.equal(ready.kind, 'ready'); assert.equal(provider.activeTurns, 1);
    const started = await provider.dispatchTurn(ready.grant, {threadId:'synthetic-thread'}); assert.equal(started.turn.id, 'synthetic-turn');
    await assert.rejects(provider.dispatchTurn(ready.grant, {threadId:'synthetic-thread'}), {code:'STALE_FENCE'});
    assert.throws(() => provider.terminal({turnLeaseId:ready.grant.leaseId, taskId:'foreign', runId:ready.grant.runId, turnId:'synthetic-turn'}), {code:'STALE_FENCE'});
    await assert.rejects(configure('wait'), {code:'STALE_FENCE'});
    provider.terminal({turnLeaseId:ready.grant.leaseId, taskId:'a', runId:ready.grant.runId, turnId:'synthetic-turn'}); assert.equal(provider.activeTurns, 0);
    // Failed CAS does not advance the owner selection revision.
    await provider.configureByClient({clientId:'synthetic-client', operationId:'synthetic-wait', expectedSelectionRevision:1, action:'synthetic', payload:{scenario:'wait'}});
    const waited = await provider.prepareTurn(task('wait')); assert.equal(waited.kind, 'waitUntil'); assert.equal(provider.activeTurns, 0); assert(cli.authenticated);
    await assert.rejects(provider.cancelWait({waitId:waited.waitId, taskId:'foreign', spaceId:'synthetic-space'}), {code:'STALE_FENCE'});
    await provider.cancelWait({waitId:waited.waitId, taskId:'wait', spaceId:'synthetic-space'});
    assert.deepEqual(await provider.cancelWait({waitId:waited.waitId, taskId:'wait', spaceId:'synthetic-space'}), {kind:'cancelled', waitId:waited.waitId});
    await assert.rejects(provider.prepareTurn(task('new-owner', waited.waitId)), {code:'STALE_FENCE'});
    await provider.authenticate();
    await configure('unknown-limits');
    assert.equal((await provider.prepareTurn(task('unknown'))).code, 'LIMITS_UNKNOWN'); assert.equal(provider.activeTurns, 0);
    await configure('slow');
    const preparing = provider.prepareTurn(task('slow', 'synthetic-wait-id'));
    await pause(10); assert.equal((await provider.prepareTurn(task('concurrent'))).code, 'BUSY_ACTIVE');
    await provider.cancelWait({waitId:'synthetic-wait-id', taskId:'slow', spaceId:'synthetic-space'});
    assert.equal((await preparing).kind, 'cancelled'); assert.equal(provider.activeTurns, 0);
    await configure('ready');
    const reserved = await provider.prepareTurn(task('reserved')); provider.releaseReserved(reserved.grant); assert.equal(provider.activeTurns, 0);
    await configure('refresh-barrier');
    const active = await provider.prepareTurn(task('refresh-active'));
    await provider.dispatchTurn(active.grant, {threadId:'synthetic-thread'});
    const duringRefresh = provider.prepareTurn(task('refresh-prepare'));
    duringRefresh.catch(() => {});
    await pause(10); await cli.request('thread/read', {threadId:'synthetic-refresh'});
    for (let tries = 0; tries < 30; tries++) {
      const observed = await cli.request('config/read');
      if (observed.methods.includes('synthetic-refresh-answered')) break;
      await pause(5);
    }
    assert((await cli.request('config/read')).methods.includes('synthetic-refresh-answered'), 'Refresh does not wait for prepare/admission mutex');
    const afterRefresh = await duringRefresh; provider.releaseReserved(afterRefresh.grant);
    provider.terminal({turnLeaseId:active.grant.leaseId, taskId:'refresh-active', runId:active.grant.runId, turnId:'synthetic-turn'});
    const status = await provider.status(); assert(status.counts.prepareTurn >= 5); assert.equal(status.counts.turnStarted, 2); assert.equal(status.counts.turnTerminal, 2);

    for (const scenario of ['no-login', 'logout', 'auth-required', 'stale-parent', 'stale-owner']) {
      const fixture = await create('bad-' + scenario); await fixture.configure(scenario);
      await assert.rejects(fixture.provider.authenticate(), error => error.reason === 'action_required' || ['STALE_FENCE', 'METHOD_NOT_SUPPORTED'].includes(error.code));
      assert(!fixture.cli.authenticated); await fixture.provider.dispose();
    }
    for (const scenario of ['bad-grant', 'needs-decision', 'auth-required']) {
      const fixture = await create('prepare-' + scenario); await fixture.provider.authenticate(); await fixture.configure(scenario);
      if (scenario === 'auth-required') assert.equal((await fixture.provider.prepareTurn(task('rejected'))).code, 'AUTH_REQUIRED');
      else await assert.rejects(fixture.provider.prepareTurn(task('rejected')), {reason:'action_required'});
      assert(!fixture.cli.authenticated); assert.equal(fixture.provider.activeTurns, 0); await fixture.provider.dispose();
    }
    const reconnect = await create('reconnect'); await reconnect.configure('reconnect');
    const before = reconnect.cli.binding.appServerGeneration; await reconnect.provider.authenticate();
    assert.notEqual(reconnect.cli.binding.appServerGeneration, before); assert(reconnect.cli.authenticated); await reconnect.provider.dispose();
    const changed = await create('new-account'); await changed.provider.authenticate();
    await changed.configure('change-account-old-revision');
    await assert.rejects(changed.provider.prepareTurn(task('account-change')), {code:'INVALID_REVISION_STEP'}); assert(!changed.cli.authenticated);
    await changed.provider.dispose();
    const rotated = await create('rotated-account'); await rotated.provider.authenticate(); await rotated.configure('change-account-new-revision');
    const rotatedReady = await rotated.provider.prepareTurn(task('rotated'));
    assert.equal(rotatedReady.grant.binding.accountRevision, 2); rotated.provider.releaseReserved(rotatedReady.grant); await rotated.provider.dispose();
    for (const scenario of ['wait','same','LIMITS_UNKNOWN','RESET_UNKNOWN','BUSY_ACTIVE','AUTH_REQUIRED','AUTH_REVOKED','STORE_UNAVAILABLE','CLIENT_REQUIRED','PLATFORM_UNSUPPORTED','PROVIDER_PROCESS_UNCERTAIN','MIRROR_BUSY','invalid']) {
      const scan = await create('scan-' + scenario); await scan.provider.authenticate(); await scan.configure('scan-' + scenario);
      if (scenario === 'invalid') await assert.rejects(scan.provider.prepareTurn(task('scan')), {code:'PROVIDER_PROTOCOL_INVALID'});
      else {
        const outcome = await scan.provider.prepareTurn(task('scan'));
        assert.equal(outcome.kind, ['wait','same'].includes(scenario) ? 'waitUntil' : 'unavailable');
        if (outcome.kind === 'unavailable') assert.equal(outcome.code, scenario);
        const waiting = ['wait','same','LIMITS_UNKNOWN','RESET_UNKNOWN','BUSY_ACTIVE'].includes(scenario);
        assert.equal(scan.cli.authenticated, waiting);
        if (waiting) assert.equal(scan.provider.accountGrant.binding.accountRevision, scenario === 'same' ? 1 : 2);
      }
      assert.equal(scan.provider.activeTurns, 0);
      await assert.rejects(scan.cli.request('turn/start', {}), error => ['STALE_FENCE','connection_unavailable'].includes(error.code));
      await scan.provider.dispose();
    }
    const pending = await create('pending-config'); await pending.provider.authenticate();
    const operation = await pending.configure('pending-config'); assert.equal(operation.kind, 'pending'); assert(pending.provider.busy);
    await assert.rejects(pending.provider.authenticate(), {code:'CLIENT_REQUIRED'});
    assert.equal((await pending.provider.prepareTurn(task('config-wait'))).code, 'BUSY_ACTIVE');
    assert.equal((await pending.provider.status({operationId:operation.operationId})).kind, 'pending');
    assert.equal((await pending.provider.status({operationId:operation.operationId})).kind, 'succeeded');
    assert(!pending.provider.busy); await pending.provider.authenticate(); await pending.provider.dispose();
    const badRefresh = await create('bad-refresh'); await badRefresh.provider.authenticate(); await badRefresh.configure('refresh-other-account');
    const refreshing = await badRefresh.provider.prepareTurn(task('bad-refresh'));
    await badRefresh.provider.dispatchTurn(refreshing.grant, {threadId:'synthetic-thread'});
    await badRefresh.cli.request('thread/read', {threadId:'synthetic-refresh'});
    for (let tries = 0; tries < 30 && badRefresh.cli.authenticated; tries++) await pause(5);
    assert(!badRefresh.cli.authenticated, 'Refresh cannot replace the active account under an existing grant');
    assert.equal(badRefresh.provider.activeTurns, 1);
    badRefresh.provider.terminal({turnLeaseId:refreshing.grant.leaseId, taskId:'bad-refresh', runId:refreshing.grant.runId, turnId:'synthetic-turn'});
    await badRefresh.provider.dispose();
    for (const [scenario, code, numeric, lostAck] of [['refresh-refuse-AUTH_REQUIRED','AUTH_REQUIRED',-32001], ['refresh-refuse-AUTH_REVOKED','AUTH_REVOKED',-32002], ['refresh-unavailable','PROVIDER_PROCESS_UNCERTAIN',-32003], ['refresh-rpc-refusal','PROVIDER_PROCESS_UNCERTAIN',-32003], ['refresh-wrong-id','PROVIDER_PROCESS_UNCERTAIN',-32003], ['refresh-mixed-refusal','PROVIDER_PROCESS_UNCERTAIN',-32003], ['refresh-refuse-AUTH_REQUIRED','AUTH_REQUIRED',-32001,true]]) {
      const refused = await create(scenario + (lostAck ? '-lost-ack' : '')); await refused.provider.authenticate(); await refused.configure(scenario);
      if (lostAck) {const original = refused.cli.refuseProvider.bind(refused.cli);refused.cli.refuseProvider = (...args) => {original(...args);throw Error('Synthetic reply outcome lost');};}
      const admitted = await refused.provider.prepareTurn(task('refused'));
      await refused.provider.dispatchTurn(admitted.grant, {threadId:'synthetic-thread'});
      const event = once(refused.provider, 'actionRequired'); let captured;
      refused.cli.on('request', request => {captured = request;});
      await refused.cli.request('thread/read', {threadId:'synthetic-refresh'}); await event;
      let observed;
      for (let attempt = 0; attempt < 30; attempt++) {observed = await refused.cli.request('config/read');if (observed.refreshReplies.length) break;await pause(5);}
      assert.equal(observed.refreshReplies.length, 1);
      assert.deepEqual(observed.refreshReplies[0].error, {code:numeric, message:'Provider access is unavailable. Open connection settings and reconnect.', data:{code}});
      assert(!JSON.stringify(observed).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'));
      assert(!JSON.stringify(observed).includes('SYNTHETIC_MUST_NOT_ESCAPE'));
      assert(!refused.cli.authenticated);assert.equal(refused.provider.accountGrant, null);assert.equal(refused.provider.activeTurns, 1);
      assert.equal(await refused.provider.handleRequest(captured), false, 'Never replay a claimed refresh');
      assert.equal((await refused.provider.status()).counts.handleRequest, 1);
      await assert.rejects(refused.cli.request('turn/start', {}), {code:'connection_unavailable'});
      refused.provider.terminal({turnLeaseId:admitted.grant.leaseId, taskId:'refused', runId:admitted.grant.runId, turnId:'synthetic-turn'});
      await refused.provider.dispose();
    }
    const badStatus = await create('bad-status'); await badStatus.configure('bad-status');
    await assert.rejects(badStatus.provider.status(), {code:'PROVIDER_PROTOCOL_INVALID'}); await badStatus.provider.dispose();
    const altered = await create('altered-config'); await altered.provider.authenticate();
    const alteredConfig = path.join(altered.directory, 'config', 'rundix-service', 'provider.json');
    fs.appendFileSync(alteredConfig, '\n');
    await assert.rejects(altered.provider.prepareTurn(task('config-change')), {code:'PROVIDER_CONFIG_INVALID'}); assert(!altered.cli.authenticated);
    await altered.provider.dispose();
    const lost = await create('provider-lost'); await lost.provider.authenticate();
    const live = await lost.provider.prepareTurn(task('live')); await lost.provider.dispatchTurn(live.grant, {threadId:'synthetic-thread'});
    const changedEvent = once(lost.provider, 'connectionChanged');
    // Identify this fixture's provider (the preceding child) independently of
    // its CLI; killing provider cannot prove the model turn terminal.
    children.at(-2).child.kill(); await changedEvent;
    assert.equal(lost.provider.activeTurns, 1); assert(!lost.cli.authenticated);
    await assert.rejects(lost.provider.dispose(), {code:'BUSY_ACTIVE'});
    lost.provider.terminal({turnLeaseId:live.grant.leaseId, taskId:'live', runId:live.grant.runId, turnId:'synthetic-turn'});
    await lost.provider.dispose();
    await provider.dispose();
    console.log('PASS provider child: handshake, external login, service grants, admission/probe, waits/cancel race, terminal ownership, fail-closed outcomes and reconnect.');
  } finally {
    for (const provider of providers) { try { await provider.dispose(); } catch {} }
    for (const {child} of children) child.kill(); await Promise.allSettled(children.map(value => value.closed));
    assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith('rundix-provider-synthetic-'));
    fs.rmSync(root, {recursive:true, force:true});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
