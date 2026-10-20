const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const net = require('node:net');
const {createServiceClient} = require('../runtime/service-adapter.cjs');
const {installLauncher, registration} = require('../runtime/service-launcher.cjs');
const {startService, locations, readDiscovery, publish} = require('../runtime/service-endpoint.cjs');
const {createTaskRpc} = require('../runtime/service-task-rpc.cjs');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-adapter-synthetic-'));
  let endpoint; const clients = [];
  try {
    for (const platform of ['win32','darwin']) {
      const opts = {platform, sid:'S-1-5-21-123456789', uid:12345, home:path.join(root,'synthetic-home'), localAppData:path.join(root,'synthetic-local')};
      const normal = locations(opts), explicit = locations({...opts, root:normal.directory});
      assert.equal(explicit.address, normal.address); assert.equal(explicit.descriptor, normal.descriptor);
    }
    const first = installLauncher({root}), saved = registration(root);
    assert(path.isAbsolute(first.configuration.mcpServers.rundix.command));
    assert.deepEqual(first.configuration.mcpServers.rundix.args, [path.join(root, 'bin', 'mcp-server.cjs'), '--service']);
    const second = installLauncher({root});
    assert.equal(first.launcher, second.launcher); assert.notEqual(registration(root).entryPath, saved.entryPath);
    assert(fs.existsSync(saved.entryPath), 'Retain the running runtime');
    const rpc = createTaskRpc();
    rpc.attach({mcp:{tasks:{call:async (_name, args) => ({space:rpc.scope(), requestId:args.requestId})}}});
    endpoint = await startService({root, ipc:{hello:rpc.hello}, call:rpc.call}); await endpoint.ready();
    const cwd = path.join(root, 'synthetic-cwd'), envRoot = path.join(root, 'synthetic-env'); fs.mkdirSync(cwd); fs.mkdirSync(envRoot);
    const a = createServiceClient({root, cwd, env:{}}), b = createServiceClient({root, cwd, env:{CLAUDE_PROJECT_DIR:envRoot}}); clients.push(a,b);
    const schemas = await a.getTools();
    assert(!schemas.some(t => t.name === 'reload_window'));
    assert(schemas.find(t => t.name === 'list_tasks').inputSchema.properties.state.enum.includes('waiting_limit'));
    const ar = await a.call(null, 'list_tasks', {}), br = await b.call(null, 'list_tasks', {});
    assert.equal(ar.space, a.space); assert.equal(br.space, b.space); assert.notEqual(ar.space, br.space);
    assert.throws(() => createServiceClient({root, cwd, env:{CLAUDE_PROJECT_DIR:path.join(root, 'absent')}}));
    const discovery = readDiscovery(locations({root}));
    clients.forEach(c => c.close());
    assert.equal((await endpoint.dispose()), undefined); endpoint = null;
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
