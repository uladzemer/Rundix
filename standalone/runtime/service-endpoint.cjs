'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {randomBytes, randomUUID, createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {SessionStore} = require('./store.cjs');
const ipc = require('./service-ipc.cjs');
const {processIdentityAsync, ownerState} = require('./service-process.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = text => createHash('sha256').update(text).digest('hex').slice(0,24);
const sidCache = new WeakMap();
function currentSid(run = execFileSync) {
  if (sidCache.has(run)) return sidCache.get(run);
  const sid = run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],
  {encoding:'utf8', windowsHide:true, timeout:10000, maxBuffer:4096}).trim();
  if (!/^S-1-[\d-]+$/.test(sid)) throw ipc.failure('ipc_security_unavailable');
  sidCache.set(run,sid); return sid;
}
function locations({platform = process.platform, root, sid, uid, home = os.homedir(), localAppData = process.env.LOCALAPPDATA} = {}) {
  const userKey = platform === 'win32' ? hash(sid || currentSid()) : String(uid ?? process.getuid());
  // Root overrides isolate BOTH discovery and the otherwise fixed per-user listener.
  const testKey = root ? '-' + hash(path.resolve(root)) : '';
  const directory = root ? path.resolve(root) : platform === 'win32'
    ? path.join(localAppData || path.join(home,'AppData','Local'), 'Rundix','service')
    : platform === 'darwin' ? path.join(home,'Library','Application Support','Rundix','service')
      : path.join(home,'.local','state','Rundix','service');
  const socketDirectory = root ? directory : `/tmp/rundix-${userKey}`;
  const address = platform === 'win32' ? `\\\\.\\pipe\\rundix-service-v1-${userKey}${testKey}` : path.posix.join(socketDirectory,'service-v1.sock');
  if (platform !== 'win32' && Buffer.byteLength(address) > 103) throw ipc.failure('endpoint_too_long');
  return {platform, directory, socketDirectory, address, descriptor:path.join(directory,'bridge.json'), kind:platform === 'win32' ? 'named_pipe' : 'unix_socket'};
}
function protectDirectory(directory, {platform = process.platform, uid = process.getuid?.(), sid, run = execFileSync} = {}) {
  fs.mkdirSync(directory,{recursive:true, mode:0o700});
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (platform !== 'win32' && info.uid !== uid)) throw ipc.failure('ipc_security_unavailable');
  if (platform === 'win32') {
    sid ||= currentSid(run);
    run('icacls.exe',[directory,'/inheritance:r','/grant:r','*'+sid+':(OI)(CI)F','*S-1-5-18:(OI)(CI)F'],
      {windowsHide:true, timeout:10000, stdio:'pipe'});
  } else fs.chmodSync(directory,0o700);
}
const transientFs = error => ['EPERM','EBUSY','EACCES'].includes(error?.code);
async function retryFs(operation, deadline = Date.now() + 2000) {
  for (;;) {
    try { return await operation(); }
    catch (error) { if (!transientFs(error) || Date.now() >= deadline) throw error; await pause(Math.min(50,deadline-Date.now())); }
  }
}
function readDiscovery(where, {io = fs, uid = process.getuid?.()} = {}) {
  try {
    const info = io.lstatSync(where.descriptor);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw Error();
    if (where.platform !== 'win32' && (info.uid !== uid || (info.mode & 0o077))) throw Error();
    const value = JSON.parse(io.readFileSync(where.descriptor,'utf8'));
    if (value.version !== 2 || value.endpoint?.address !== where.address || value.endpoint?.kind !== where.kind ||
      !/^[a-f0-9]{64}$/.test(value.secret) || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      typeof value.processStart !== 'string' || !value.processStart || typeof value.generation !== 'string' ||
      !['starting','ready'].includes(value.status)) throw Error();
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; if (transientFs(error)) throw ipc.failure(error.code); throw ipc.failure('ipc_security_unavailable'); }
}
async function readDiscoveryWithRetry(where, options = {}, deadline = Infinity) {
  try {
    return await retryFs(() => readDiscovery(where), Math.min(deadline,Date.now() + (options.discoveryRetryMs ?? 2000)));
  } catch (error) {
    if (transientFs(error)) throw ipc.failure('discovery_unavailable');
    throw error;
  }
}
function publish(where, descriptor) {
  const temp = where.descriptor + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp,JSON.stringify(descriptor),{flag:'wx', mode:0o600});
    fs.renameSync(temp,where.descriptor);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
async function guarded(store, operation, budget = 2000) {
  const until = Date.now() + budget;
  let release;
  while (!release) {
    try { release = store.acquire('service-startup'); }
    catch { if (Date.now() >= until) throw ipc.failure('service_busy'); await pause(20); }
  }
  try { return await operation(); } finally { release(); }
}
async function stateOf(descriptor, inspect = processIdentityAsync) {
  if (!descriptor) return 'unknown';
  const current = await inspect(descriptor.pid);
  return ownerState(descriptor,() => current);
}
function connectProbe(address, timeoutMs = 500) {
  return new Promise(resolve => {
    const socket = net.createConnection(address);
    const finish = state => { clearTimeout(timer); socket.destroy(); resolve(state); };
    const timer = setTimeout(() => finish('unknown'),timeoutMs);
    socket.once('connect',() => finish('listening'));
    socket.once('error',error => finish(error.code === 'ECONNREFUSED' ? 'refused' : 'unknown'));
  });
}
// Caller holds service-startup through this operation AND listen/publication.
// A missing descriptor is recoverable only when the OS proves no listener exists.
async function reclaimSocket(where, {io = fs, read = readDiscovery, probe = connectProbe, inspectProcess} = {}) {
  let info;
  try { info = io.lstatSync(where.address); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isSocket() || info.isSymbolicLink()) throw ipc.failure('ipc_security_unavailable');
  const previous = read(where);
  if (previous && await stateOf(previous,inspectProcess) !== 'dead') return false;
  if (await probe(where.address) !== 'refused') return false;
  io.unlinkSync(where.address); return true;
}
async function startService(options = {}) {
  const where = locations(options);
  await retryFs(() => protectDirectory(where.directory));
  if (where.platform !== 'win32' && where.socketDirectory !== where.directory) await retryFs(() => protectDirectory(where.socketDirectory));
  const store = new SessionStore(where.directory), peers = new Set();
  const identity = await (options.inspectProcess || processIdentityAsync)(process.pid);
  if (identity.state !== 'alive') throw ipc.failure('owner_unverified');
  const descriptor = {version:2, endpoint:{kind:where.kind,address:where.address}, status:'starting',
    serviceVersion:options.serviceVersion || '0.0.0', protocol:{min:1,max:1}, pid:process.pid,
    processStart:identity.processStart, generation:randomUUID(), secret:randomBytes(32).toString('hex'), entryPath:options.entryPath || ''};
  let stopping = false, closed = false, disposal, activeCalls = 0;
  const server = net.createServer(socket => {
    if (stopping || peers.size >= 64) { socket.destroy(); return; }
    const peer = ipc.accept(socket,{...options.ipc, secret:descriptor.secret, generation:descriptor.generation,
      status:() => descriptor.status, call:options.call ? async (...args) => {
        if (activeCalls >= 64) throw ipc.failure('limit');
        activeCalls++;
        try { return await options.call(...args); } finally { activeCalls--; }
      } : undefined});
    peers.add(peer); peer.once('closed', () => peers.delete(peer));
  });
  let owner = false;
  await guarded(store, async () => {
    if (where.platform !== 'win32') await retryFs(() => reclaimSocket(where,{inspectProcess:options.inspectProcess}));
    try {
      await new Promise((resolve,reject) => {
        const failed = error => { server.removeListener('listening', ready); reject(error); };
        const ready = () => { server.removeListener('error', failed); resolve(); };
        server.once('error',failed); server.once('listening',ready); server.listen(where.address);
      });
    } catch (error) { if (error.code === 'EADDRINUSE') return; throw error; }
    owner = true;
    try { await retryFs(() => publish(where,descriptor)); }
    catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  });
  if (!owner) return {status:'already_running', connect:extra => connectService({...options, ...extra})};
  server.on('error', () => { for (const peer of peers) peer.close(); });
  return {status:'owner', generation:descriptor.generation,
    ready:() => guarded(store, async () => {
      if (stopping) throw ipc.failure('service_unavailable');
      descriptor.status = 'ready'; await retryFs(() => publish(where,descriptor));
    }),
    clients:() => peers.size,
    busy:() => activeCalls > 0,
    broadcast(method, params) { for (const peer of peers) if (peer.authenticated) { try { peer.send({method,params:{...params,generation:descriptor.generation}}); } catch { peer.close(); } } },
    dispose() {
      if (disposal) return disposal;
      stopping = true;
      // A failed guard acquisition leaves disposal retryable. Keep close under the guard:
      // Node unlinks Unix sockets on server.close, so a new listener must not race it.
      disposal = guarded(store, async () => {
        if (!closed) {
          for (const peer of peers) peer.close();
          await new Promise(resolve => server.close(resolve)); closed = true;
        }
        await retryFs(() => {
          if (readDiscovery(where)?.generation === descriptor.generation) fs.unlinkSync(where.descriptor);
        });
      }).catch(error => {
        if (!closed) stopping = false;
        disposal = null; throw error;
      });
      return disposal;
    }};
}
async function connectService(options = {}) {
  const where = locations(options), deadline = Date.now() + (options.startupTimeoutMs || 20000);
  let delay = 100;
  do {
    let peer;
    try {
      const descriptor = await readDiscoveryWithRetry(where,options,deadline);
      if (descriptor) {
        peer = await ipc.dial(where.address,{...options.ipc, connectTimeoutMs:Math.max(1,Math.min(2000,deadline-Date.now()))});
        return await ipc.authenticate(peer, descriptor, options.pingTimeoutMs || 5000, deadline, options.hello);
      }
    } catch (error) {
      peer?.close();
      if (!transientFs(error) && !['auth_failed','service_initializing','service_unavailable','connect_timeout','rpc_timeout'].includes(error.code)) throw error;
    }
    await pause(Math.max(0,Math.min(delay,deadline-Date.now()))); delay = Math.min(1000,delay*2);
  } while (Date.now() < deadline);
  throw ipc.failure('service_start_timeout');
}
async function probeOwner(options = {}) {
  const where = locations(options), descriptor = await readDiscoveryWithRetry(where,options);
  if (!descriptor) return {state:'absent'};
  let peer;
  try {
    peer = await ipc.dial(where.address,{connectTimeoutMs:options.pingTimeoutMs || 2000});
    const ping = await peer.request('service.ping',{},options.pingTimeoutMs || 5000);
    return {state:ping.generation === descriptor.generation ? 'responding' : 'unverified'};
  } catch {
    const state = await stateOf(descriptor,options.inspectProcess);
    return {state:state === 'alive' ? 'hung' : state, generation:descriptor.generation};
  } finally { peer?.close(); }
}
// Explicit recovery hook, not an automatic kill policy. The launcher must verify the installed
// entry and stop registered children with their own OS identities before reporting success.
async function recoverHung(options = {}) {
  if (!options.verifyEntry || !options.stopVerified) throw ipc.failure('owner_unverified');
  const where = locations(options), store = new SessionStore(where.directory);
  const descriptor = await readDiscoveryWithRetry(where,options);
  const first = await probeOwner(options);
  if (first.state === 'responding') throw ipc.failure('service_busy');
  if (first.state !== 'hung' || !(await options.verifyEntry(descriptor))) throw ipc.failure('owner_unverified');
  const second = await probeOwner(options);
  if (second.state !== 'hung' || second.generation !== descriptor?.generation) throw ipc.failure('owner_unverified');
  // Slow ping/entry probes do not hold the startup lease. Revalidate before stop,
  // then again before cleanup; a replacement generation is never touched.
  await guarded(store, async () => {
    if ((await readDiscoveryWithRetry(where,options))?.generation !== descriptor.generation || await stateOf(descriptor,options.inspectProcess) !== 'alive') throw ipc.failure('owner_unverified');
    await options.stopVerified({pid:descriptor.pid,processStart:descriptor.processStart,entryPath:descriptor.entryPath});
  });
  const deadline = Date.now() + (options.deathTimeoutMs || 2000);
  while (await stateOf(descriptor,options.inspectProcess) !== 'dead') {
    if (Date.now() >= deadline) throw ipc.failure('recovery_required');
    await pause(250);
  }
  return guarded(store, async () => {
    if ((await readDiscoveryWithRetry(where,options))?.generation !== descriptor.generation) throw ipc.failure('owner_unverified');
    if (where.platform !== 'win32' && fs.existsSync(where.address)) {
      if (!(await reclaimSocket(where,{inspectProcess:options.inspectProcess}))) throw ipc.failure('owner_unverified');
    }
    fs.unlinkSync(where.descriptor);
    return {state:'recovered'};
  });
}
module.exports = {locations, currentSid, protectDirectory, readDiscovery, publish, startService, connectService, probeOwner, recoverHung, reclaimSocket};
