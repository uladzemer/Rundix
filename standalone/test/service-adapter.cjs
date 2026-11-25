require('./test-isolation.cjs').isolate();
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const net = require('node:net');
const {createServiceClient} = require('../runtime/service-adapter.cjs');
const {installLauncher, registration} = require('../runtime/service-launcher.cjs');
const {startService, connectService, locations, readDiscovery, publish} = require('../runtime/service-endpoint.cjs');
const {createTaskRpc} = require('../runtime/service-task-rpc.cjs');
const {serviceEnvironment} = require('../runtime/service-environment.cjs');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-adapter-synthetic-'));
  let endpoint; const clients = [];
  try {
    const platformKeys=['ProgramFiles','ProgramFiles(x86)','ProgramW6432','ProgramData','SystemDrive','USERNAME','USERDOMAIN','HOMEDRIVE','HOMEPATH','PSModulePath','ALLUSERSPROFILE','PUBLIC','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','OS','TMPDIR','SHELL','USER','LOGNAME','XDG_CONFIG_HOME','SSL_CERT_FILE','SSL_CERT_DIR','ALL_PROXY'];
    const system=Object.fromEntries(platformKeys.map(key=>[key,'synthetic']));
    for(const key of platformKeys)assert.equal(serviceEnvironment(system)[key],'synthetic');
    const clean=serviceEnvironment({PATH:'synthetic-path',CODEX_HOME:'synthetic-home',LC_ALL:'C',HTTPS_PROXY:'synthetic-proxy',GITHUB_TOKEN:'SYNTHETIC',AWS_PROFILE:'synthetic',DATABASE_URL:'synthetic',NODE_OPTIONS:'synthetic',CLAUDE_PROJECT_DIR:'synthetic'});
    assert.deepEqual(clean,{PATH:'synthetic-path',CODEX_HOME:'synthetic-home',LC_ALL:'C',HTTPS_PROXY:'synthetic-proxy',ELECTRON_RUN_AS_NODE:'1'});
    for (const platform of ['win32','darwin']) {
      const opts = {pathEnv:{}, platform, sid:'S-1-5-21-123456789', uid:12345, home:path.join(root,'synthetic-home'), localAppData:path.join(root,'synthetic-local')};
      const normal = locations(opts), explicit = locations({...opts, root:normal.directory});
      assert.equal(explicit.address, normal.address); assert.equal(explicit.descriptor, normal.descriptor);
    }
    const day = 24 * 60 * 60 * 1000, now = Date.UTC(2030, 0, 20);
    const versions = path.join(root, 'versions');
    const ageCopy = (copy, days) => fs.utimesSync(copy, (now - days * day) / 1000, (now - days * day) / 1000);
    const makeCopy = (name, complete = true) => {
      const copy = path.join(versions, name);
      fs.mkdirSync(copy);
      if (complete) fs.writeFileSync(path.join(copy, 'complete.json'), JSON.stringify({version:'0.0.0'}));
      return copy;
    };
    const first = installLauncher({root, now:now-day}), saved = registration(root);
    const savedCopy = path.dirname(path.dirname(saved.entryPath));
    assert(path.isAbsolute(first.configuration.mcpServers.rundix.command));
    assert.deepEqual(first.configuration.mcpServers.rundix.args, [path.join(root, 'bin', 'mcp-server.cjs'), '--service']);
    const second = installLauncher({root, now});
    assert.equal(first.launcher, second.launcher); assert.equal(registration(root).entryPath, saved.entryPath);assert.equal(fs.readdirSync(path.join(root,'versions')).length,1,'Reuse identical runtime');
    assert(fs.existsSync(saved.entryPath), 'Retain the running runtime');
    assert.equal(fs.statSync(savedCopy).mtimeMs, now, 'Identical installation refreshes the existing copy');
    const idleCopies = Array.from({length:4}, (_, index) => {
      const copy = makeCopy('0.0.0-synthetic-' + index);
      ageCopy(copy, 20 + index);
      return copy;
    });
    const freshIncomplete = makeCopy('0.0.0-synthetic-fresh-incomplete', false);
    const oldIncomplete = makeCopy('0.0.0-synthetic-old-incomplete', false);
    ageCopy(freshIncomplete, 0.5 / 24); ageCopy(oldIncomplete, 2 / 24);
    const where = locations({root});
    fs.writeFileSync(where.descriptor,'{}', {mode:0o600}); installLauncher({root, now});
    assert.equal(fs.readdirSync(versions).length,7,'Unreadable owner descriptor prevents pruning');
    fs.unlinkSync(where.descriptor); installLauncher({root, now});
    assert.equal(fs.readdirSync(versions).length,4,'Idle installation prunes obsolete copies');
    assert(idleCopies.slice(0, 2).every(copy => fs.existsSync(copy)), 'Only complete copies count toward the two-copy floor');
    assert(idleCopies.slice(2).every(copy => !fs.existsSync(copy)), 'Prune older copies beyond the floor');
    assert(fs.existsSync(freshIncomplete), 'Keep an incomplete copy within its one-hour grace period');
    assert(!fs.existsSync(oldIncomplete), 'Prune an incomplete copy older than one hour');
    const running = makeCopy('0.0.0-synthetic-running', false);
    const runningEntry = path.join(running, 'service-main.cjs');
    fs.writeFileSync(runningEntry, '// Synthetic entry');
    ageCopy(running, 40);
    const recent = makeCopy('0.0.0-synthetic-recent');
    const stale = makeCopy('0.0.0-synthetic-stale');
    const busy = makeCopy('0.0.0-synthetic-busy');
    ageCopy(recent, 13); ageCopy(stale, 15); ageCopy(busy, 14.5);
    const future = [1, 2, 3].map(days => {
      const copy = makeCopy('0.0.0-synthetic-future-' + days);
      ageCopy(copy, -days);
      return copy;
    });
    const outside = path.join(root, 'synthetic-outside');
    fs.mkdirSync(outside);
    const outsideEntry = path.join(outside, 'service-main.cjs');
    fs.writeFileSync(outsideEntry, '// Synthetic entry');
    const unrecognized = makeCopy('unrecognized-copy');
    ageCopy(unrecognized, 40);
    const linked = path.join(versions, '0.0.0-synthetic-link');
    fs.symlinkSync(outside, linked, 'junction');
    ageCopy(outside, 40);

    const rpc = createTaskRpc();
    rpc.attach({mcp:{tasks:{call:async (_name, args) => ({space:rpc.scope(), requestId:args.requestId})}}});
    endpoint = await startService({root, entryPath:runningEntry, ipc:{hello:rpc.hello}, call:rpc.call}); await endpoint.ready();
    const discovery = readDiscovery(where);
    const beforeInvalidOwner = fs.readdirSync(versions).sort();
    publish(where, {...discovery, entryPath:path.join(linked, 'service-main.cjs')});
    installLauncher({root, now});
    assert(fs.existsSync(stale), 'An owner entry through a junction prevents pruning');
    publish(where, {...discovery, entryPath:outsideEntry});
    installLauncher({root, now});
    assert.deepEqual(fs.readdirSync(versions).sort(), beforeInvalidOwner, 'An owner entry outside versions prevents all pruning');
    publish(where, discovery);

    const source = path.join(root, 'synthetic-source');
    fs.mkdirSync(path.join(source, 'runtime'), {recursive:true});
    fs.mkdirSync(path.join(source, 'ui'));
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({version:'0.0.0'}));
    for (const name of ['service-main.cjs', 'service-adapter.cjs']) {
      fs.writeFileSync(path.join(source, 'runtime', name), '// Synthetic entry');
    }
    const uiFile = 'synthetic.js', uiContents = '// Synthetic UI';
    fs.writeFileSync(path.join(source, 'ui', uiFile), uiContents);
    ageCopy(savedCopy, 30);
    const {rmSync, renameSync, utimesSync, readdirSync} = fs;
    const renamed = [];
    let failedRemovals = 0;
    try {
      fs.renameSync = (from, to) => {
        renamed.push(to);
        return renameSync(from, to);
      };
      fs.rmSync = (file, options) => {
        if (file === busy) {
          failedRemovals++;
          throw Object.assign(new Error('Synthetic busy copy'), {code:'EBUSY'});
        }
        return rmSync(file, options);
      };
      assert.equal(installLauncher({root, source, now}).launcher, first.launcher);
    } finally { fs.rmSync = rmSync; fs.renameSync = renameSync; }
    const current = registration(root);
    assert.notEqual(current.entryPath, saved.entryPath);
    assert(fs.existsSync(current.entryPath), 'Keep the registered target');
    assert(fs.existsSync(runningEntry), 'Keep the older running copy');
    assert.equal(fs.statSync(savedCopy).mtimeMs, now, 'Refresh the outgoing target at replacement');
    assert(fs.existsSync(recent), 'Keep the copy last registered 13 days ago');
    assert(!fs.existsSync(stale), 'Prune the copy last registered 15 days ago while the service runs');
    assert.equal(failedRemovals, 1);
    assert(fs.existsSync(busy), 'Keep the busy copy after a deletion error');
    assert(future.every(copy => fs.existsSync(copy)), 'Keep future timestamps beyond the two-copy floor');
    assert(fs.existsSync(unrecognized), 'Keep names outside the copy pattern');
    assert(fs.lstatSync(linked).isSymbolicLink(), 'Keep the junction entry');
    assert(fs.existsSync(outsideEntry), 'Keep files outside versions');

    const outgoing = path.dirname(path.dirname(current.entryPath));
    ageCopy(outgoing, 30);
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({version:'0.0.1'}));
    const existing = fs.readdirSync(versions);
    const syntheticFailure = code => Object.assign(new Error('Synthetic filesystem failure'), {code});
    try {
      fs.utimesSync = (file, ...times) => {
        if (file === outgoing) throw syntheticFailure('EPERM');
        return utimesSync(file, ...times);
      };
      assert.equal(installLauncher({root, source, now}).launcher, first.launcher);
    } finally { fs.utimesSync = utimesSync; }
    const afterFailure = registration(root);
    assert.equal(afterFailure.version, '0.0.1', 'A previous-target timestamp error does not prevent registration');
    assert(existing.every(name => fs.existsSync(path.join(versions, name))), 'No copies are pruned after a previous-target timestamp error');
    assert.equal(fs.statSync(path.dirname(path.dirname(afterFailure.entryPath))).mtimeMs, now, 'Still refresh the new target');

    const failedStamps = [];
    let failedScans = 0;
    try {
      fs.utimesSync = file => { failedStamps.push(file); throw syntheticFailure('EPERM'); };
      fs.readdirSync = (dir, ...args) => {
        if (dir === versions) { failedScans++; throw syntheticFailure('EBUSY'); }
        return readdirSync(dir, ...args);
      };
      fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({version:'0.0.2'}));
      installLauncher({root, source, now:now+day});
      const afterStampFailures = registration(root);
      assert.equal(afterStampFailures.version, '0.0.2', 'Publish even when all timestamp operations fail');
      assert.deepEqual(failedStamps, [afterFailure, afterStampFailures].map(value => path.dirname(path.dirname(value.entryPath))));
      assert.equal(failedScans, 0, 'Skip pruning when timestamps cannot be refreshed');
      fs.utimesSync = utimesSync;
      fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({version:'0.0.3'}));
      installLauncher({root, source, now:now+day});
      assert.equal(failedScans, 1);
      assert.equal(registration(root).version, '0.0.3', 'A pruning error does not prevent registration');
      for (const [invalidNow, version] of [[NaN, '0.0.4'], [0, '0.0.5']]) {
        fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({version}));
        installLauncher({root, source, now:invalidNow});
        assert.equal(registration(root).version, version, 'Publish registration even with an invalid clock');
        assert.equal(failedScans, 1, 'An invalid clock skips pruning');
      }
    } finally { fs.utimesSync = utimesSync; fs.readdirSync = readdirSync; }
    assert(!renamed.some(file => /^(prune-after$|0\.prune-)/.test(path.basename(file))), 'Cleanup never stages a file or copy');
    assert(!fs.existsSync(path.join(root, 'prune-after')));
    assert(!fs.readdirSync(versions).some(name => name.startsWith('0.prune-')));
    assert(fs.existsSync(runningEntry), 'Cleanup still keeps the running service copy');

    const marker = path.join(outgoing, 'complete.json');
    const installedUi = path.join(outgoing, 'ui', uiFile);
    const unlinkSync = fs.unlinkSync;
    let removalAttempts = 0, markerWasAbsent = false;
    try {
      fs.unlinkSync = file => {
        if (file === marker) throw syntheticFailure('EPERM');
        return unlinkSync(file);
      };
      fs.rmSync = (file, options) => {
        if (file !== outgoing) return rmSync(file, options);
        removalAttempts++;
        markerWasAbsent = !fs.existsSync(marker);
        unlinkSync(current.entryPath);
        unlinkSync(installedUi);
        throw syntheticFailure('EBUSY');
      };
      installLauncher({root, source, now:now+day});
      assert.equal(removalAttempts, 0, 'A marker unlink error must skip recursive removal');
      assert(fs.existsSync(marker));
      fs.unlinkSync = unlinkSync;
      installLauncher({root, source, now:now+day});
    } finally { fs.unlinkSync = unlinkSync; fs.rmSync = rmSync; }
    assert.equal(removalAttempts, 1, 'Retry a failed deletion on a later install');
    assert(markerWasAbsent, 'Remove the completion marker before recursively deleting a copy');
    assert(!fs.existsSync(current.entryPath));
    assert(!fs.existsSync(installedUi));
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({version:current.version}));
    installLauncher({root, source, now:now+day});
    assert.deepEqual(registration(root), current, 'Reinstall the same version-hash at its original paths');
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), {version:current.version});
    assert.equal(fs.readFileSync(current.entryPath, 'utf8'), '// Synthetic entry');
    assert.equal(fs.readFileSync(installedUi, 'utf8'), uiContents);
    const cwd = path.join(root, 'synthetic-cwd'), envRoot = path.join(root, 'synthetic-env'); fs.mkdirSync(cwd); fs.mkdirSync(envRoot);
    const a = createServiceClient({root, cwd, env:{}}), b = createServiceClient({root, cwd, env:{CLAUDE_PROJECT_DIR:envRoot}}); clients.push(a,b);
    const schemas = await a.getTools();
    assert(!schemas.some(t => t.name === 'reload_window'));
    assert(schemas.find(t => t.name === 'list_tasks').inputSchema.properties.state.enum.includes('waiting_limit'));
    const ar = await a.call(null, 'list_tasks', {}), br = await b.call(null, 'list_tasks', {});
    assert.equal((await a.call(null,'wait_tasks',{taskIds:['synthetic'],waitSeconds:null})).space,ar.space,'Null uses the default wait budget');
    for(const waitSeconds of ['30',0,-1,1501,{}])await assert.rejects(a.call(null,'wait_task',{taskId:'synthetic',waitSeconds}),{code:'invalid_argument'});
    assert.equal((await a.call(null,'list_tasks',{})).space,ar.space,'Malformed waits retain the shared connection');
    assert.equal(ar.space, a.space); assert.equal(br.space, b.space); assert.notEqual(ar.space, br.space);
    assert.throws(() => createServiceClient({root, cwd, env:{CLAUDE_PROJECT_DIR:path.join(root, 'absent')}}));
    let firstUnavailable=0;const immediate=await connectService({root,onUnavailable:()=>{firstUnavailable++;},hello:{clientKind:'adapter',binding:{source:'cwd',launchDirectory:cwd}}});immediate.close();assert.equal(firstUnavailable,0,'First dial does not demand-start again');
    clients.forEach(c => c.close());
    assert.equal((await endpoint.dispose()), undefined); endpoint = null;
    let spawns=0;
    publish(locations({root}),discovery);
    const cold=createServiceClient({root,cwd,env:{},inspectProcess:async()=>({state:'dead'}),spawnProcess(){
      spawns++;fs.unlinkSync(locations({root}).descriptor);const child=new (require('node:events').EventEmitter)();child.unref=()=>{};
      setTimeout(()=>{void (async()=>{endpoint=await startService({root,ipc:{hello:rpc.hello},call:rpc.call});await endpoint.ready();})();},400);
      return child;
    }});clients.push(cold);await cold.getTools();assert.equal(spawns,1,'Slow discovery publication spawns once per absent generation');cold.close();await endpoint.dispose();endpoint=null;
    let replacements=0;
    const replacing=createServiceClient({root,cwd,env:{},startupTimeoutMs:6000,spawnProcess(){
      const attempt=++replacements,child=new (require('node:events').EventEmitter)();child.unref=()=>{};
      setTimeout(()=>{void (async()=>{
        endpoint=await startService({root,ipc:{hello:rpc.hello},call:rpc.call});
        if(attempt===1){const dying=endpoint;setTimeout(()=>{void dying.dispose();},700);}else await endpoint.ready();
      })();},400);return child;
    }});clients.push(replacing);await replacing.getTools();assert.equal(replacements,2,'An observed starting generation may exit before hello and demand its successor');replacing.close();await endpoint.dispose();endpoint=null;
    // A listener that accepts but never answers must share the complete startup
    // deadline with process-identity probing; no second 20-second budget.
    const sockets = new Set(), silent = net.createServer(socket => {sockets.add(socket);socket.on('close', () => sockets.delete(socket));});
    await new Promise(resolve => silent.listen(where.address, resolve)); publish(where, discovery);
    const stalled = createServiceClient({root, cwd, env:{}, startupTimeoutMs:100, pingTimeoutMs:30,
      inspectProcess:async () => {await new Promise(resolve => setTimeout(resolve, 200));return {state:'alive',processStart:discovery.processStart};}});
    const began = Date.now();
    try {await assert.rejects(stalled.getTools(), {code:'service_start_timeout'});assert(Date.now() - began < 250);}
    finally {stalled.close();sockets.forEach(socket => socket.destroy());await new Promise(resolve => silent.close(resolve));}
    fs.unlinkSync(where.descriptor);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'installation.json')));
    config.entryPath = process.execPath; fs.writeFileSync(path.join(root, 'installation.json'), JSON.stringify(config), {mode:0o600});
    assert.throws(() => registration(root), {code:'service_install_required'});
    console.log('PASS service adapter: stable trusted snapshot, retained versions, negotiated schemas and real IPC launch-space binding.');
  } finally {clients.forEach(c => c.close()); await endpoint?.dispose(); fs.rmSync(root, {recursive:true, force:true});}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
