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
    const first = installLauncher({root}), saved = registration(root);
    assert(path.isAbsolute(first.configuration.mcpServers.rundix.command));
    assert.deepEqual(first.configuration.mcpServers.rundix.args, [path.join(root, 'bin', 'mcp-server.cjs'), '--service']);
    const second = installLauncher({root});
    assert.equal(first.launcher, second.launcher); assert.equal(registration(root).entryPath, saved.entryPath);assert.equal(fs.readdirSync(path.join(root,'versions')).length,1,'Reuse identical runtime');
    assert(fs.existsSync(saved.entryPath), 'Retain the running runtime');
    for(let index=0;index<4;index++)fs.mkdirSync(path.join(root,'versions','0.0.0-synthetic-'+index));
    fs.writeFileSync(path.join(root,'bridge.json'),'{}');installLauncher({root});
    assert.equal(fs.readdirSync(path.join(root,'versions')).length,5,'Published owner prevents pruning');
    fs.unlinkSync(path.join(root,'bridge.json'));installLauncher({root});
    assert.equal(fs.readdirSync(path.join(root,'versions')).length,3,'Idle installation prunes obsolete copies');
    const rpc = createTaskRpc();
    rpc.attach({mcp:{tasks:{call:async (_name, args) => ({space:rpc.scope(), requestId:args.requestId})}}});
    endpoint = await startService({root, ipc:{hello:rpc.hello}, call:rpc.call}); await endpoint.ready();
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
    const discovery = readDiscovery(locations({root}));
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
    const where = locations({root}), sockets = new Set(), silent = net.createServer(socket => {sockets.add(socket);socket.on('close', () => sockets.delete(socket));});
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
