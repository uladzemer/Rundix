const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {createHeadlessHost, plainSettings, boundedLogger} = require('../runtime/service-headless-host.cjs');
const {ServiceAppServer} = require('../runtime/service-cli.cjs');
const {install} = require('./service-provider-fixture.cjs');
const {runService} = require('../runtime/service-main.cjs');
const {connectService} = require('../runtime/service-endpoint.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-headless-host-synthetic-'));
  const children = []; let host, service, peer, loseAck = false, lateAck = false;
  const launch = (executable, args, options) => {
    const child = spawn(executable, args, options); children.push({child, closed:once(child, 'close')}); return child;
  };
  try {
    const project = path.join(root, 'synthetic-project'); fs.mkdirSync(project);
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({mcpMaxParallelTasks:2, mcpAccessMode:'manual'}));
    const liveSettings=plainSettings(root);assert.equal(liveSettings('mcpMaxParallelTasks'),2);
    fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({mcpMaxParallelTasks:1,mcpAccessMode:'manual'}));
    assert.equal(liveSettings('mcpMaxParallelTasks'),1,'Service rereads user safety settings');
    const settingsModule=require('../runtime/service-settings.cjs');
    assert.deepEqual(settingsModule.normalizeSettings(key=>({globalValue:{mcpAccessMode:'invalid',mcpMaxParallelTasks:99,mcpThreadConfig:[],cliPath:42}[key]})),{mcpMaxParallelTasks:5});
    assert.equal(settingsModule.normalizeSettings(()=>({globalValue:'invalid'})).mcpMaxParallelTasks,1);
    fs.writeFileSync(path.join(root,'settings.json'),'{');assert.equal(liveSettings('mcpAccessMode'),'manual','Read failure keeps last valid safety snapshot');
    fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({mcpMaxParallelTasks:1,mcpAccessMode:'manual'}));
    const invalidSettingsRoot=path.join(root,'synthetic-invalid-settings');
    await settingsModule.writeServiceSettings(invalidSettingsRoot,key=>({globalValue:{mcpAccessMode:'invalid',mcpMaxParallelTasks:99,mcpThreadConfig:[],cliPath:42}[key]}));
    assert.equal(plainSettings(invalidSettingsRoot)('mcpMaxParallelTasks'),5);
    assert.equal(plainSettings(invalidSettingsRoot)('mcpAccessMode','workspace'),'workspace');
    fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({mcpMaxParallelTasks:1,mcpAccessMode:'auto'}));
    const originalFstat=fs.fstatSync;let raced=false;
    try{fs.fstatSync=function(fd){const stat=originalFstat(fd);if(!raced){raced=true;return {...stat,ino:stat.ino+1};}return stat;};assert.equal(liveSettings('mcpAccessMode'),'auto','Atomic replacement race retries instead of using stale snapshot');assert(raced);}
    finally{fs.fstatSync=originalFstat;}
    fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({mcpMaxParallelTasks:1,mcpAccessMode:'manual'}));
    const installed = install(root);
    host = await createHeadlessHost({root, generation:'synthetic-service', resolveCli:async () => process.execPath,
      providerOptions:{configPath:installed.configPath, verifyPrivate:() => {}, spawnProcess:launch,
        createCli:options => {
          const cli = new ServiceAppServer({...options, spawnProcess:(_exe, argv, opts) => {
          assert(argv.includes('cli_auth_credentials_store="ephemeral"'));
          return launch(process.execPath, [path.join(__dirname, 'fake-headless-cli.cjs')], opts);
          }});
          const request = cli.request.bind(cli);
          cli.request = async (...args) => {
            const result = await request(...args);
            if (loseAck && args[0] === 'turn/start') {
              loseAck = false;
              setTimeout(() => cli.emit('notification', {method:'turn/completed', params:{threadId:args[1].threadId,
                turn:{id:'synthetic-stale-turn', status:'completed'}}}), lateAck ? 80 : 5);
              if (lateAck) await pause(120);
              throw Object.assign(Error('Synthetic lost ACK'), {deliveryUncertain:true});
            }
            return result;
          };
          return cli;
        }}});
    assert.equal(children.length, 0, 'Provider/CLI start lazily');
    const submit = await host.mcp.tasks.call('submit_task', {requestId:'synthetic-submit', description:'Synthetic task', acceptanceCriteria:'Synthetic check', projectDirectory:project});
    await host.mcp.tasks.tick(); await host.mcp.tasks.idle();
    assert.equal(children.length, 2); assert(host.provider.cli.authenticated); assert(host.busy());
    const completed = await host.mcp.tasks.call('wait_task', {taskId:submit.taskId, waitSeconds:2});
    assert.equal(completed.state, 'completed'); assert.equal(completed.report.result, 'Synthetic success');
    assert.equal(host.provider.activeTurns, 0);
    await host.mcp.tasks.call('continue_task', {taskId:submit.taskId, requestId:'synthetic-continue', clarification:'Synthetic followup'});
    await host.mcp.tasks.tick(); await host.mcp.tasks.idle();
    const continued = await host.mcp.tasks.call('wait_task', {taskId:submit.taskId, waitSeconds:2});
    assert.equal(continued.state, 'completed'); assert.equal(continued.chatId, completed.chatId);
    assert.equal((await host.mcp.tasks.call('close_task', {taskId:submit.taskId})).chatClosed, false);
    assert.throws(() => host.mcp.tasks.call('reload_window', {}), {code:'unsupported'});
    loseAck = true;
    const unknown = await host.mcp.tasks.call('submit_task', {requestId:'synthetic-lost-ack', description:'Synthetic ambiguous send', acceptanceCriteria:'Synthetic terminal', projectDirectory:project});
    await host.mcp.tasks.tick(); await host.mcp.tasks.idle(); await pause(150); await host.mcp.tasks.tick();
    assert.equal(host.provider.activeTurns, 0, 'Typed start+completion release a grant despite a lost ACK');
    assert.equal(host.mcp.tasks.get(unknown.taskId).recoveryRequired, false);
    loseAck = true; lateAck = true;
    const delayed = await host.mcp.tasks.call('submit_task', {requestId:'synthetic-buffered-ack', description:'Synthetic delayed ACK', acceptanceCriteria:'Synthetic terminal', projectDirectory:project});
    await host.mcp.tasks.tick(); await host.mcp.tasks.idle(); await host.mcp.tasks.tick();
    assert.equal(host.provider.activeTurns, 0, 'A stale event after real completion cannot overwrite buffered terminal evidence');
    assert.equal(host.mcp.tasks.get(delayed.taskId).recoveryRequired, false);
    const log = boundedLogger(root); log({code:'service_started', text:'SYNTHETIC_IGNORED_TEXT'}); log('SYNTHETIC_IGNORED_TEXT');
    const logs = fs.readFileSync(path.join(root, 'diagnostics', 'service-0.log'), 'utf8');
    assert(!logs.includes(root)); assert(!logs.includes('SYNTHETIC_IGNORED_TEXT'));
    for (let rotation = 0; rotation < 4; rotation++) {
      fs.writeFileSync(path.join(root, 'diagnostics', 'service-0.log'), '0'.repeat(1024 * 1024)); log({code:'service_started'});
    }
    assert.equal(fs.readdirSync(path.join(root, 'diagnostics')).length, 3);
    await host.dispose(); host = null;
    const absentRoot = path.join(root, 'no-provider'); fs.mkdirSync(absentRoot);
    const absent = await createHeadlessHost({root:absentRoot, generation:'synthetic-absent-provider',
      resolveCli:async () => process.execPath, providerOptions:{configPath:path.join(absentRoot, 'absent-provider.json')}});
    await assert.rejects(absent.core.connect(), {code:'PROVIDER_NOT_CONFIGURED', reason:'action_required'});
    await absent.dispose();
    const serviceRoot = path.join(root, 'service-process'); fs.mkdirSync(serviceRoot);
    service = await runService({root:serviceRoot, idleMs:50, pollMs:10});
    assert.equal(service.status, 'owner');
    peer = await connectService({root:serviceRoot, hello:{clientKind:'adapter', binding:{launchDirectory:serviceRoot, source:'cwd'}}});
    await pause(100); assert(fs.existsSync(path.join(serviceRoot, 'bridge.json')), 'A connected client prevents idle exit');
    assert.equal((await runService({root:serviceRoot})).status, 'already_running', 'Singleton loser creates no second host');
    peer.close(); peer = null;
    for (let attempt = 0; attempt < 100 && fs.existsSync(path.join(serviceRoot, 'bridge.json')); attempt++) await pause(20);
    assert(!fs.existsSync(path.join(serviceRoot, 'bridge.json')), 'Idle empty service exits after disconnect'); service = null;
    const broken = path.join(root, 'invalid'); fs.mkdirSync(broken); fs.writeFileSync(path.join(broken, 'settings.json'), '{');
    assert.equal(plainSettings(broken)('mcpAccessMode','workspace'),'workspace');
    assert(fs.readdirSync(path.join(root, 'sessions-v1')).some(file => file.startsWith('session-')));
    console.log('PASS headless host: real core/executor, lazy framed provider + ephemeral CLI, report/continue/close, unsupported UI, file KV/settings and bounded safe diagnostics.');
  } finally {
    peer?.close(); try {await service?.dispose();} catch {}
    try {await host?.dispose();} catch {}
    for (const {child} of children) child.kill(); await Promise.allSettled(children.map(value => value.closed));
    assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith('rundix-headless-host-synthetic-'));
    fs.rmSync(root, {recursive:true, force:true});
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
