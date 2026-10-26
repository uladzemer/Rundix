require('./test-isolation.cjs').isolate();
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {PassThrough, Duplex} = require('node:stream');
const {spawn} = require('node:child_process');
const endpoint = require('../runtime/service-endpoint.cjs');
const ipc = require('../runtime/service-ipc.cjs');
const {ownerState, processIdentity} = require('../runtime/service-process.cjs');
const {idleExit} = require('../runtime/service-lifecycle.cjs');
const {SessionStore} = require('../runtime/store.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

// Separate processes exercise the actual OS singleton, never the user's fixed endpoint.
if (process.argv[2] === 'candidate') {
  (async () => {
    const service = await endpoint.startService({root:process.argv[3],call:async () => ({synthetic:true})});
    if (service.status === 'owner') await service.ready();
    else { const client = await service.connect(); assert.deepEqual(await client.call('synthetic.echo'),{synthetic:true}); client.close(); }
    process.send(service.status);
    process.on('message', async () => { if (service.dispose) await service.dispose(); process.exit(0); });
  })().catch(error => { console.error('candidate_failed:' + (/^[a-z_]{1,40}$/.test(error?.code || '') ? error.code : 'rejected')); process.exit(1); });
} else {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
async function main() {
  const root = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp','rdx-ipc-synthetic-'));
  const cleanup = [];
  const testRoot = name => path.join(root,name);
  const own = async (name, options = {}) => {
    const service = await endpoint.startService({root:testRoot(name),...options}); cleanup.push(() => service.dispose?.());
    assert.equal(service.status,'owner'); await service.ready(); return service;
  };
  let count = 0;
  const test = async (name, fn) => { await fn(); count++; console.log('ok service IPC: '+name); };
  try {
    await test('fixed names, test isolation, SID hashing and POSIX layout', async () => {
      const win = endpoint.locations({platform:'win32',sid:'S-1-5-21-100-200-300-400',root:testRoot('names')});
      assert.match(win.address,/^\\\\\.\\pipe\\rundix-service-v1-[a-f0-9]{24}-[a-f0-9]{24}$/);
      assert.equal(win.address,endpoint.locations({platform:'win32',sid:'S-1-5-21-100-200-300-400',root:testRoot('names')}).address);
      assert.notEqual(win.address,endpoint.locations({platform:'win32',sid:'S-1-5-21-100-200-300-400',root:testRoot('other')}).address);
      for (const platform of ['darwin','linux']) {
        const posix = endpoint.locations({pathEnv:{},platform,uid:42420,home:'/synthetic'});
        assert.equal(posix.address,'/tmp/rundix-42420/service-v1.sock');
      }
      assert.throws(() => endpoint.currentSid(() => 'invalid'),{code:'ipc_security_unavailable'});
      let queries = 0;
      const sidQuery = (_command,_args,options) => { queries++; assert.equal(options.timeout,10000); return 'S-1-5-21-100'; };
      assert.equal(endpoint.currentSid(sidQuery),'S-1-5-21-100');
      assert.equal(endpoint.currentSid(sidQuery),'S-1-5-21-100'); assert.equal(queries,1);
      const calls = [];
      endpoint.protectDirectory(testRoot('acl'),{platform:'win32',sid:'S-1-5-21-100',run:(...args) => calls.push(args)});
      assert.deepEqual(calls[0][1].slice(1),['/inheritance:r','/grant:r','*S-1-5-21-100:(OI)(CI)F','*S-1-5-18:(OI)(CI)F']);
      // Exercise chmod and UID rejection even on Windows (NTFS does not expose POSIX mode bits).
      endpoint.protectDirectory(testRoot('chmod'),{platform:'linux',uid:fs.lstatSync(testRoot('acl')).uid});
      if (process.platform !== 'win32') assert.equal(fs.statSync(testRoot('chmod')).mode & 0o777,0o700);
      assert.throws(() => endpoint.protectDirectory(testRoot('chmod'),{platform:'linux',uid:-42}),{code:'ipc_security_unavailable'});
    });
    await test('two racing processes: one owner, loser connects', async () => {
      const children = [0,1].map(() => spawn(process.execPath,[__filename,'candidate',testRoot('race')],{stdio:['ignore','ignore','inherit','ipc'],windowsHide:true}));
      cleanup.push(async () => { for (const child of children) if (child.exitCode === null) child.kill(); });
      const statuses = await Promise.all(children.map(child => new Promise((resolve,reject) => {
        const timer = setTimeout(() => reject(Error('candidate timeout')),15000);
        child.once('message',status => { clearTimeout(timer); resolve(status); });
        child.once('exit',code => { clearTimeout(timer); reject(Error('candidate exited '+code)); });
      })));
      assert.deepEqual(statuses.sort(),['already_running','owner']);
      await Promise.all(children.map(child => new Promise(resolve => { child.once('exit',resolve); child.send('stop'); })));
    });
    await test('stale dead discovery replaced atomically; owner-scoped cleanup', async () => {
      const where = endpoint.locations({root:testRoot('stale')}); endpoint.protectDirectory(where.directory);
      endpoint.publish(where,{version:2,endpoint:{kind:where.kind,address:where.address},pid:42420,processStart:'synthetic-old',generation:'synthetic-old',secret:'a'.repeat(64),status:'ready'});
      const service = await own('stale'); assert.equal(endpoint.readDiscovery(where).generation,service.generation);
      assert.equal(fs.readdirSync(where.directory).some(name => name.endsWith('.tmp')),false);
      await service.dispose(); assert.equal(endpoint.readDiscovery(where),null);
    });
    await test('POSIX stale unlink requires absent/dead owner and refused connection under guard', async () => {
      const store = new SessionStore(testRoot('unlink'));
      const where = {address:'/synthetic/service-v1.sock'};
      const descriptor = {pid:42420,processStart:'synthetic-old'};
      for (const scenario of [
        {descriptor,identity:{state:'dead'},probe:'refused',removed:true},
        {descriptor,identity:{state:'alive',processStart:'synthetic-reused'},probe:'refused',removed:true},
        {descriptor:null,probe:'refused',removed:true},
        {descriptor,identity:{state:'dead'},probe:'listening',removed:false},
        {descriptor:null,probe:'unknown',removed:false},
        {descriptor,identity:{state:'alive',processStart:'synthetic-old'},probe:'refused',removed:false},
        {descriptor,identity:{state:'unknown'},probe:'refused',removed:false}
      ]) {
        let removed = 0, guarded = false;
        const release = store.acquire('service-startup'); guarded = true;
        try {
          const result = await endpoint.reclaimSocket(where,{
            io:{lstatSync:() => ({isSocket:() => true,isSymbolicLink:() => false}),unlinkSync:address => {
              assert.equal(guarded,true); assert.equal(address,where.address); removed++;
            }},read:() => scenario.descriptor, inspectProcess:async () => scenario.identity,
            probe:async () => { assert.equal(guarded,true); return scenario.probe; }
          });
          assert.equal(result,scenario.removed); assert.equal(removed,Number(scenario.removed));
        } finally { guarded = false; release(); }
      }
      assert.equal(ownerState(descriptor,() => ({state:'alive',processStart:'synthetic-reused'})),'dead');
      await assert.rejects(endpoint.reclaimSocket(where,{io:{lstatSync:() => ({isSocket:() => false,isSymbolicLink:() => true})}}),{code:'ipc_security_unavailable'});
    });
    await test('transient discovery/rename errors retry; security failures remain hard', async () => {
      const where = endpoint.locations({root:testRoot('fs-retry')});
      const rename = fs.renameSync; let renames = 0;
      fs.renameSync = (from,to) => {
        if (to === where.descriptor && ++renames <= 3) throw Object.assign(Error('synthetic'),{code:['EPERM','EBUSY','EACCES'][renames-1]});
        return rename(from,to);
      };
      try { await own('fs-retry'); assert(renames >= 4); } finally { fs.renameSync = rename; }
      const read = fs.readFileSync; let reads = 0;
      fs.readFileSync = (file,...args) => {
        if (file === where.descriptor && ++reads <= 3) throw Object.assign(Error('synthetic'),{code:['EPERM','EBUSY','EACCES'][reads-1]});
        return read(file,...args);
      };
      try {
        const client = await endpoint.connectService({root:testRoot('fs-retry'),startupTimeoutMs:2500}); client.close(); assert.equal(reads,4);
      } finally { fs.readFileSync = read; }
      const withReadFailures = async (failures, operation) => {
        let attempts = 0;
        fs.readFileSync = (file,...args) => {
          if (file === where.descriptor && ++attempts <= failures) throw Object.assign(Error('synthetic'),{code:'EACCES'});
          return read(file,...args);
        };
        try { await operation(); assert(attempts > 1); } finally { fs.readFileSync = read; }
      };
      const retryOptions = {root:testRoot('fs-retry'),discoveryRetryMs:100,startupTimeoutMs:1000};
      await withReadFailures(Infinity,async () => {
        await assert.rejects(endpoint.connectService(retryOptions),{code:'discovery_unavailable'});
        await assert.rejects(endpoint.probeOwner(retryOptions),{code:'discovery_unavailable'});
        await assert.rejects(endpoint.recoverHung({...retryOptions,verifyEntry:async () => true,stopVerified:async () => assert.fail('must not stop')}),{code:'discovery_unavailable'});
      });
      await withReadFailures(2,async () => assert.equal((await endpoint.probeOwner({...retryOptions,discoveryRetryMs:500})).state,'responding'));
      await withReadFailures(2,async () => {
        await assert.rejects(endpoint.recoverHung({...retryOptions,discoveryRetryMs:500,verifyEntry:async () => true,stopVerified:async () => assert.fail('must not stop')}),{code:'service_busy'});
      });
      const invalid = {lstatSync:() => ({isFile:() => true,isSymbolicLink:() => true,size:1})};
      assert.throws(() => endpoint.readDiscovery(where,{io:invalid}),{code:'ipc_security_unavailable'});
      for (const info of [{uid:42,mode:0o600},{uid:43,mode:0o644}]) {
        assert.throws(() => endpoint.readDiscovery({...where,platform:'linux'},{uid:43,io:{lstatSync:() => ({...info,isFile:() => true,isSymbolicLink:() => false,size:1})}}),{code:'ipc_security_unavailable'});
      }
    });
    await test('request/response/event; no task access before hello; wrong secret and replay', async () => {
      const service = await own('auth',{call:async (method,params) => { if (method === 'synthetic.fail') throw Error('synthetic-private-detail'); return {value:params.value}; }});
      const where = endpoint.locations({root:testRoot('auth')}), descriptor = endpoint.readDiscovery(where);
      const raw = await ipc.dial(where.address); cleanup.push(() => raw.close());
      await assert.rejects(raw.request('synthetic.echo',{generation:descriptor.generation}),{code:'auth_failed'});
      const ping = await raw.request('service.ping');
      const hello = {protocol:{min:1,max:1},generation:descriptor.generation,serverNonce:ping.serverNonce,proof:ipc.proof('b'.repeat(64),descriptor.generation,ping.serverNonce)};
      await assert.rejects(raw.request('service.hello',hello), error => error.code === 'auth_failed' && !error.message.includes(descriptor.secret));
      hello.proof = ipc.proof(descriptor.secret,descriptor.generation,ping.serverNonce);
      await assert.rejects(raw.request('service.hello',hello),{code:'auth_failed'});
      const expired = await raw.request('service.ping');
      const now = Date.now; Date.now = () => now() + 6000;
      try { await assert.rejects(raw.request('service.hello',{...hello,serverNonce:expired.serverNonce,proof:ipc.proof(descriptor.secret,descriptor.generation,expired.serverNonce)}),{code:'auth_failed'}); }
      finally { Date.now = now; }
      const wire = await ipc.dial(where.address); cleanup.push(() => wire.close());
      const frames = [], write = wire.socket.write.bind(wire.socket);
      wire.socket.write = (chunk,...args) => { frames.push(String(chunk)); return write(chunk,...args); };
      await ipc.authenticate(wire,descriptor);
      assert(!frames.join('').includes(descriptor.secret)); wire.close();
      const client = await endpoint.connectService({root:testRoot('auth')}); cleanup.push(() => client.close());
      assert.deepEqual(await client.call('synthetic.echo',{value:'synthetic'}),{value:'synthetic'});
      await assert.rejects(client.call('synthetic.fail'),error => error.message === 'rejected');
      await assert.rejects(client.request('synthetic.echo',{generation:'synthetic-stale'}),{code:'stale_instance'});
      const event = new Promise(resolve => client.once('event',(method,params) => resolve({method,params})));
      service.broadcast('synthetic.changed',{revision:1});
      assert.deepEqual(await event,{method:'synthetic.changed',params:{revision:1,generation:service.generation}});
    });
    await test('startup auth_failed rereads discovery and retries', async () => {
      await own('retry');
      const where = endpoint.locations({root:testRoot('retry')}), correct = endpoint.readDiscovery(where);
      endpoint.publish(where,{...correct,secret:'b'.repeat(64)});
      const timer = setTimeout(() => endpoint.publish(where,correct),180);
      try { const client = await endpoint.connectService({root:testRoot('retry'),startupTimeoutMs:1500}); client.close(); }
      finally { clearTimeout(timer); endpoint.publish(where,correct); }
    });
    await test('starting owner stays available to ping and waits for ready', async () => {
      const service = await endpoint.startService({root:testRoot('starting')}); cleanup.push(() => service.dispose());
      const timer = setTimeout(() => service.ready(),160);
      try { const client = await endpoint.connectService({root:testRoot('starting'),startupTimeoutMs:1500}); client.close(); }
      finally { clearTimeout(timer); }
    });
    await test('frame size, incremental lines, incomplete timeout, bounded pending and backpressure', async () => {
      const stream = new PassThrough(); const peer = new ipc.Peer(stream,{maxFrame:64,frameTimeoutMs:25});
      peer.read(Buffer.from('x'.repeat(65))); assert.equal(peer.closed,true);
      const partial = new ipc.Peer(new PassThrough(),{frameTimeoutMs:25});
      partial.read(Buffer.from('{')); await sleep(40); assert.equal(partial.closed,true);
      const lines = new ipc.Peer(new PassThrough(),{maxFrame:64}); let received = 0;
      lines.receive = () => received++;
      lines.read(Buffer.from(('{'+'"jsonrpc":"2.0","result":1}\n').repeat(20)));
      assert.equal(received,20); lines.close();
      const slow = new ipc.Peer(new PassThrough(),{maxQueue:16});
      assert.throws(() => slow.send({method:'synthetic'}),{code:'backpressure'});
      const service = await own('large');
      const raw = await ipc.dial(endpoint.locations({root:testRoot('large')}).address);
      const closed = new Promise(resolve => raw.once('closed',resolve));
      raw.socket.write(Buffer.alloc(ipc.MAX_FRAME+1,120)); await closed;
      await service.dispose();
      const pending = new ipc.Peer(new Duplex({read(){},write(_chunk,_encoding,done){done();}}));
      await assert.rejects(pending.request('synthetic',{},20),{code:'rpc_timeout'}); pending.close();
    });
    await test('per-call deadlines retain work slots and preserve other calls/events', async () => {
      const output = [];
      const peer = new ipc.Peer(new Duplex({read(){},write(chunk,_encoding,done){output.push(JSON.parse(chunk)); done();}}),{
        handlerTimeoutMs:25, getHandlerTimeoutMs:(method,params) => method === 'synthetic.wait' ? params.budget : undefined});
      let release, callSignal;
      const work = new Promise(resolve => { release = resolve; });
      peer.handler = async (method,_params,context) => {
        if (method === 'synthetic.hang') { callSignal = context.signal; await work; return 'late'; }
        if (method === 'synthetic.wait') await sleep(60);
        return method;
      };
      peer.receive({jsonrpc:'2.0',id:'hang',method:'synthetic.hang'});
      peer.receive({jsonrpc:'2.0',id:'wait',method:'synthetic.wait',params:{budget:500}});
      await sleep(90);
      assert.equal(peer.closed,false); assert.equal(peer.signal.aborted,false); assert.equal(callSignal.aborted,true);
      assert.equal(peer.inflight,1);
      assert.deepEqual(output.find(row => row.id === 'hang').error,{code:'rpc_timeout',message:'rpc_timeout'});
      assert.equal(output.find(row => row.id === 'wait').result,'synthetic.wait');
      peer.receive({jsonrpc:'2.0',id:'next',method:'synthetic.next'});
      peer.send({method:'synthetic.event',params:{revision:1}});
      await sleep(5); assert.equal(output.find(row => row.id === 'next').result,'synthetic.next');
      release(); await sleep(5); assert.equal(peer.inflight,0);
      assert.equal(output.filter(row => row.id === 'hang').length,1); peer.close();
    });
    await test('ping and hello share the full startup deadline', async () => {
      const where = endpoint.locations({root:testRoot('deadline')}); endpoint.protectDirectory(where.directory);
      const peers = new Set();
      const server = net.createServer(socket => {
        const peer = new ipc.Peer(socket); peers.add(peer); peer.once('closed',() => peers.delete(peer));
        peer.handler = async method => { await sleep(70); return method === 'service.ping'
          ? {generation:'synthetic-deadline',status:'ready',serverNonce:'a'.repeat(64)}
          : {generation:'synthetic-deadline',protocol:1}; };
      });
      await new Promise(resolve => server.listen(where.address,resolve));
      cleanup.push(async () => { for (const peer of peers) peer.close(); await new Promise(resolve => server.close(resolve)); });
      endpoint.publish(where,{version:2,endpoint:{kind:where.kind,address:where.address},pid:42420,processStart:'synthetic-start',generation:'synthetic-deadline',secret:'a'.repeat(64),status:'ready'});
      await assert.rejects(endpoint.connectService({root:testRoot('deadline'),startupTimeoutMs:110,pingTimeoutMs:100}),{code:'service_start_timeout'});
    });
    await test('dispose is retryable after startup guard contention', async () => {
      const service = await own('dispose');
      const where = endpoint.locations({root:testRoot('dispose')});
      const release = new SessionStore(where.directory).acquire('service-startup');
      try {
        await assert.rejects(service.dispose(),{code:'service_busy'});
        assert.equal(endpoint.readDiscovery(where).status,'ready');
        const client = await endpoint.connectService({root:testRoot('dispose'),startupTimeoutMs:1000});
        try { assert.equal((await client.request('service.ping')).status,'ready'); } finally { client.close(); }
      }
      finally { release(); }
      await service.ready();
      const read = fs.readFileSync, unlink = fs.unlinkSync;
      let reads = 0, unlinks = 0;
      fs.readFileSync = (file,...args) => {
        if (file === where.descriptor && ++reads === 1) throw Object.assign(Error('synthetic'),{code:'EPERM'});
        return read(file,...args);
      };
      fs.unlinkSync = file => {
        if (file === where.descriptor && ++unlinks <= 2) throw Object.assign(Error('synthetic'),{code:'EBUSY'});
        return unlink(file);
      };
      try { await service.dispose(); assert(reads >= 4); assert.equal(unlinks,3); }
      finally { fs.readFileSync = read; fs.unlinkSync = unlink; }
      assert.equal(endpoint.readDiscovery(where),null);
      const replacement = await own('dispose'); await replacement.dispose();
    });
    await test('ping timeout checks PID/start time; recovery is explicit and fails closed', async () => {
      const where = endpoint.locations({root:testRoot('hung')}); endpoint.protectDirectory(where.directory);
      const sockets = new Set(); const server = net.createServer(socket => { sockets.add(socket); socket.on('close',() => sockets.delete(socket)); });
      await new Promise(resolve => server.listen(where.address,resolve));
      cleanup.push(async () => { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
      endpoint.publish(where,{version:2,endpoint:{kind:where.kind,address:where.address},pid:42420,processStart:'synthetic-start',generation:'synthetic-hung',secret:'a'.repeat(64),status:'ready',entryPath:'synthetic-entry.cjs'});
      let alive = true;
      const options = {root:testRoot('hung'),pingTimeoutMs:25,inspectProcess:() => alive ? {state:'alive',processStart:'synthetic-start'} : {state:'dead'}};
      assert.equal((await endpoint.probeOwner(options)).state,'hung');
      assert.equal((await endpoint.probeOwner({...options,inspectProcess:() => ({state:'alive',processStart:'synthetic-reused'})})).state,'dead');
      await assert.rejects(endpoint.recoverHung(options),{code:'owner_unverified'});
      let stopped = 0;
      await assert.rejects(endpoint.recoverHung({...options,verifyEntry:async () => false,stopVerified:async () => stopped++}),{code:'owner_unverified'});
      assert.equal(stopped,0);
      assert.deepEqual(await endpoint.recoverHung({...options,verifyEntry:async () => true,stopVerified:async () => { stopped++; for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); alive = false; }}),{state:'recovered'});
      assert.equal(stopped,1); assert.equal(endpoint.readDiscovery(where),null);
      assert.equal(ownerState({pid:42420,processStart:'synthetic-start'},() => ({state:'unknown'})),'unverified');
      assert.equal(processIdentity(process.pid).state,'alive');
    });
    await test('reused PID: CIM-style ticks tolerance, unreadable identity, pipe absence and denied access', async () => {
      const serviceProcess = require('../runtime/service-process.cjs');
      const ticksAt = ms => String(BigInt(Math.round(ms)) * 10000n + 621355968000000000n);
      const base = ticksAt(Date.parse('2026-10-24T10:00:00Z'));
      // Same moment read by Get-Process and by CIM (sub-ms rounding) is the same process; a later start is a reused PID.
      assert.equal(ownerState({pid:42,processStart:base},() => ({state:'alive',processStart:String(BigInt(base) + 7n)})),'alive');
      assert.equal(ownerState({pid:42,processStart:base},() => ({state:'alive',processStart:ticksAt(Date.parse('2026-10-25T10:00:00Z'))})),'dead');
      assert.equal(ownerState({pid:42,processStart:base},() => ({state:'unknown'})),'unverified');
      assert.equal(serviceProcess.startedAtMs({state:'alive',processStart:ticksAt(1700000000000)}),1700000000000);
      assert.equal(serviceProcess.startedAtMs({state:'unknown'}),null);
      assert.equal(serviceProcess.startedAtMs({state:'alive',processStart:'boot:123'}),null);
      const script = serviceProcess.windowsStartScript(1234);
      assert(script.includes('Win32_Process') && script.includes('ProcessId=1234') && script.includes('Get-Process -Id 1234'));
      // Dial failure on a missing pipe + unverified owner = dead (the launcher spawns); an unreadable-but-present pipe stays unverified.
      const where = endpoint.locations({root:testRoot('reused-pid')}); endpoint.protectDirectory(where.directory);
      endpoint.publish(where,{version:2,endpoint:{kind:where.kind,address:where.address},pid:42421,processStart:'synthetic-start',generation:'synthetic-gone',secret:'b'.repeat(64),status:'ready',entryPath:'synthetic-entry.cjs'});
      const unreadable = {root:testRoot('reused-pid'),pingTimeoutMs:50,inspectProcess:() => ({state:'unknown'})};
      assert.equal((await endpoint.probeOwner(unreadable)).state,'dead');
      assert.equal((await endpoint.probeOwner({...unreadable,inspectProcess:() => ({state:'alive',processStart:'synthetic-start'})})).state,'hung');
      const create = net.createConnection;
      net.createConnection = () => { const socket = new PassThrough(); socket.destroy = () => {}; setImmediate(() => socket.emit('error',Object.assign(Error('synthetic'),{code:'EACCES'}))); return socket; };
      try { assert.equal((await endpoint.probeOwner(unreadable)).state,'unverified'); }
      finally { net.createConnection = create; }
      net.createConnection = () => { const socket = new PassThrough(); socket.destroy = () => {}; setImmediate(() => socket.emit('error',Object.assign(Error('synthetic'),{code:'EPERM'}))); return socket; };
      try { assert.equal((await endpoint.probeOwner(unreadable)).state,'unverified'); }
      finally { net.createConnection = create; }
    });
    await test('EPERM from process.kill still queries the start time (sync and async)', async () => {
      const childProcess = require('node:child_process'), originalKill = process.kill, originalSync = childProcess.execFileSync, originalAsync = childProcess.execFile;
      const modulePath = require.resolve('../runtime/service-process.cjs'), cached = require.cache[modulePath];
      const queries = [], other = process.pid + 100000, ticks = '639000000000000000';
      let killCode = 'EPERM';
      try {
        process.kill = (pid, signal) => { if (pid === other) throw Object.assign(Error('synthetic'),{code:killCode}); return originalKill.call(process,pid,signal); };
        childProcess.execFileSync = (...args) => { queries.push(args[0]); return ticks + '\n'; };
        childProcess.execFile = (...args) => { queries.push(args[0]); args[args.length - 1](null,{stdout:ticks + '\n',stderr:''}); };
        delete require.cache[modulePath];
        const fresh = require('../runtime/service-process.cjs');
        assert.deepEqual(fresh.processIdentity(other,'win32'),{state:'alive',processStart:ticks});
        assert.deepEqual(await fresh.processIdentityAsync(other,'win32'),{state:'alive',processStart:ticks});
        assert.deepEqual(queries,['powershell.exe','powershell.exe']);
        killCode = 'ESRCH';
        assert.deepEqual(fresh.processIdentity(other,'win32'),{state:'dead'});
        assert.deepEqual(await fresh.processIdentityAsync(other,'win32'),{state:'dead'});
        assert.equal(queries.length,2);
      } finally {
        process.kill = originalKill; childProcess.execFileSync = originalSync; childProcess.execFile = originalAsync;
        delete require.cache[modulePath]; if (cached) require.cache[modulePath] = cached;
      }
    });
    await test('lease held by a reused PID becomes stale only when its process started after the lease', async () => {
      const serviceProcess = require('../runtime/service-process.cjs'), identity = serviceProcess.processIdentity;
      const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      cleanup.push(() => child.kill());
      const directory = path.join(root,'lease-reuse'), store = new SessionStore(directory), lease = store.file('lease','reuse');
      const ticksAt = ms => String(BigInt(Math.round(ms)) * 10000n + 621355968000000000n);
      let queries = 0;                                                   // the reuse check caches per (pid, lease mtime): each case gets its own age
      const writeLease = ageMs => {
        fs.writeFileSync(lease,JSON.stringify({pid:child.pid,nonce:'synthetic'}));
        const when = new Date(Date.now() - ageMs); fs.utimesSync(lease,when,when);
      };
      const startedAgo = (leaseAgeMs, afterLeaseMs) => () => { queries++; return {state:'alive',processStart:ticksAt(Date.now() - leaseAgeMs + afterLeaseMs)}; };
      try {
        writeLease(60000);
        serviceProcess.processIdentity = startedAgo(60000,-60000);
        assert.throws(() => store.acquire('reuse'),error => error.code === 'SESSION_BUSY'); // process older than the lease: owner is alive
        writeLease(61000);
        serviceProcess.processIdentity = () => { queries++; return {state:'unknown'}; };
        assert.throws(() => store.acquire('reuse'));                     // unreadable identity keeps the old behaviour
        writeLease(62000);
        serviceProcess.processIdentity = startedAgo(62000,20000);
        assert.throws(() => store.acquire('reuse'));                     // within the 30 s clock slack
        writeLease(5000);
        const young = queries;
        serviceProcess.processIdentity = startedAgo(5000,1000);
        assert.throws(() => store.acquire('reuse'));                     // young lease: no query at all
        assert.equal(queries,young);
        // Cache: identical (pid, mtime) is answered once, however many times the acquire loop retries.
        writeLease(64000);
        const cached = queries;
        serviceProcess.processIdentity = startedAgo(64000,-1000);
        for (let attempt = 0; attempt < 5; attempt++) assert.throws(() => store.acquire('reuse'));
        assert.equal(queries,cached + 1);
        // assertNoActiveTurns: a lease whose pid was reused is not an active turn; a genuine one is.
        const turns = new SessionStore(path.join(root,'lease-turns')), turn = turns.file('lease','turn');
        const writeTurn = ageMs => { fs.writeFileSync(turn,JSON.stringify({pid:child.pid,nonce:'synthetic'})); const when = new Date(Date.now() - ageMs); fs.utimesSync(turn,when,when); };
        writeTurn(70000);
        serviceProcess.processIdentity = startedAgo(70000,-5000);
        assert.throws(() => turns.assertNoActiveTurns());
        writeTurn(71000);
        serviceProcess.processIdentity = startedAgo(71000,50000);
        turns.assertNoActiveTurns();
        writeLease(63000);
        serviceProcess.processIdentity = startedAgo(63000,50000);
        store.acquire('reuse')();                                        // started after the lease: reused PID, reaped
      } finally { serviceProcess.processIdentity = identity; }
    });
    await test('dispose removes the descriptor before the pipe closes', async () => {
      const disposeRoot = testRoot('dispose-order'), where = endpoint.locations({root:disposeRoot}), serverClose = net.Server.prototype.close;
      const service = await endpoint.startService({root:disposeRoot,call:async () => ({})});
      assert.equal(service.status,'owner'); await service.ready();
      assert(fs.existsSync(where.descriptor));
      let descriptorAtClose = null;
      net.Server.prototype.close = function (...args) { descriptorAtClose = fs.existsSync(where.descriptor); return serverClose.apply(this,args); };
      try { await service.dispose(); } finally { net.Server.prototype.close = serverClose; }
      assert.equal(descriptorAtClose,false);
      assert(!fs.existsSync(where.descriptor));
    });
    await test('service start failure leaves a safe diagnostic event', async () => {
      const {reportStartFailure} = require('../runtime/service-main.cjs');
      const failRoot = testRoot('start-failed');
      reportStartFailure({root:failRoot},Object.assign(Error('C:\\Users\\private\\secret'),{code:'EPERM'}));
      reportStartFailure({root:failRoot},Object.assign(Error('private text'),{code:'not a safe code!'}));
      const log = fs.readFileSync(path.join(endpoint.locations({root:failRoot}).directory,'diagnostics','service-0.log'),'utf8');
      const rows = log.trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(rows.map(row => [row.code,row.errorCode]),[['service_start_failed','EPERM'],['service_start_failed','Error']]);
      assert(!/private|secret|Users/.test(log));
    });
    await test('idle hook resets on busy, rearms on failure/decline and reports safe errors', async () => {
      let clients = 1, busy = false, time = 0, tick, cancelled = false, fires = 0;
      const errors = [];
      const hook = idleExit({clients:() => clients,busy:() => busy,
        now:() => time, schedule:callback => { tick = callback; return {}; }, cancel:() => { cancelled = true; },
        log:error => errors.push(error), onIdle:async () => {
          fires++;
          if (fires === 1) throw Object.assign(Error('synthetic-private-detail'),{code:'service_busy'});
          if (fires === 2) return {exiting:false};
          return {exiting:true};
        },idleMs:100});
      cleanup.push(() => hook.dispose());
      const advance = async ms => { time += ms; await tick(); };
      await advance(1000); assert.equal(fires,0);
      clients = 0; busy = true; await advance(1000); assert.equal(fires,0);
      busy = false; await advance(0); await advance(50); busy = true; await advance(200);
      busy = false; await advance(0); await advance(99); assert.equal(fires,0);
      await advance(1); assert.equal(fires,1); assert.equal(cancelled,false);
      assert.deepEqual(errors,[{code:'service_busy'}]);
      await advance(0); await advance(100); assert.equal(fires,2); assert.equal(cancelled,false);
      clients = 1; await advance(500); assert.equal(fires,2);
      clients = 0; await advance(0); await advance(100); assert.equal(fires,3); assert.equal(cancelled,true);
      await advance(1000); assert.equal(fires,3);
    });
    console.log(`service IPC: ${count} synthetic checks passed`);
  } finally {
    for (const dispose of cleanup.reverse()) await dispose();
    fs.rmSync(root,{recursive:true,force:true});
  }
}
