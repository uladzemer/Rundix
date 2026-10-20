// Whole public transport path. Only synthetic provider/app-server children run.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {installLauncher, registration} = require('../runtime/service-launcher.cjs');
const {readDiscovery, locations} = require('../runtime/service-endpoint.cjs');
const {processIdentityAsync} = require('../runtime/service-process.cjs');
const {install} = require('./service-provider-fixture.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {if (await check()) return;await pause(30);}
  throw Error('Synthetic end-to-end deadline');
}
function adapter(launcher, cwd, project) {
  const env = {...process.env, ELECTRON_RUN_AS_NODE:'1'}; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  if (project) env.CLAUDE_PROJECT_DIR = project; else delete env.CLAUDE_PROJECT_DIR;
  const child = spawn(process.execPath, [launcher, '--service'], {cwd, env, windowsHide:true, stdio:['pipe','pipe','pipe']});
  const closed = once(child, 'close'), pending = new Map(); let sequence = 0, buffer = '', stderr = '';
  child.stderr.on('data', chunk => {stderr += chunk;});
  child.stdout.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const row = pending.get(value.id); if (!row) continue; pending.delete(value.id);clearTimeout(row.timer);
      if (value.error) row.reject(Object.assign(Error('Synthetic MCP failure'), value.error)); else row.resolve(value.result);
    }
  });
  child.on('close', () => {for (const row of pending.values()) {clearTimeout(row.timer);row.reject(Error('Synthetic adapter closed'));}pending.clear();});
  function rpc(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {pending.delete(id);reject(Error('Synthetic MCP deadline'));}, 25000);
      pending.set(id, {resolve,reject,timer}); child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params}) + '\n');
    });
  }
  return {child, closed, rpc, stderr:() => stderr,
    async call(name, args = {}) {
      const value = await rpc('tools/call', {name,arguments:args});
      if (value.isError) throw Object.assign(Error(value.content[0].text), {toolError:true});
      return JSON.parse(value.content[0].text);
    },
    async close() {child.stdin.end();await closed;assert.equal(stderr, '');},
  };
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-e2e-synthetic-'));
  const clients = []; let owner;
  try {
    const installed = install(root), setup = installLauncher({root}), reg = registration(root);
    const entry = path.join(path.dirname(reg.entryPath), 'synthetic-service-entry.cjs');
    const audit = path.join(root, 'synthetic-cli-check.json');
    fs.writeFileSync(entry, `const fs=require('node:fs');
const {fixture}=require(${JSON.stringify(path.join(__dirname,'service-fixture.cjs'))});
const root=${JSON.stringify(root)};
const data=fixture(root,{installed:{configPath:${JSON.stringify(installed.configPath)}},observeCli:value=>fs.writeFileSync(${JSON.stringify(audit)},JSON.stringify(value))});
require(${JSON.stringify(reg.entryPath)}).runService({root,hostOptions:data.hostOptions,idleMs:2000,pollMs:20}).catch(()=>{process.stderr.write('synthetic_service_failure');process.exitCode=1;});
`);
    reg.entryPath = entry; fs.writeFileSync(path.join(root, 'installation.json'), JSON.stringify(reg), {mode:0o600});
    const a = path.join(root, 'repo-a'), b = path.join(root, 'repo-b');
    for (const dir of [a,b]) {fs.mkdirSync(path.join(dir,'.git'), {recursive:true});}
    const ca = adapter(setup.launcher, a), cb = adapter(setup.launcher, a, b); clients.push(ca,cb);
    for (const client of clients) await client.rpc('initialize', {protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic',version:'1.0.0'}});
    // Concurrent first calls race demand-start; only the singleton owner serves both.
    const schemas = await Promise.all(clients.map(c => c.rpc('tools/list', {})));
    assert(schemas.every(s => !s.tools.some(t => t.name === 'reload_window')));
    owner = readDiscovery(locations({root}));assert(owner?.pid > 0);assert.notEqual(owner.pid,process.pid);
    // Longer than connectService's maximum 1s discovery backoff, so the fixture
    // cannot idle-exit between ready publication and the first client hello.
    await pause(2200);assert.equal(readDiscovery(locations({root})).generation, owner.generation, 'Connected clients prevent idle exit');
    const args = {requestId:'synthetic-same-id',description:'Synthetic task',acceptanceCriteria:'Synthetic checks'};
    const ta = await ca.call('submit_task', {...args,projectDirectory:b});
    const tb = await cb.call('submit_task', {...args,projectDirectory:a});assert.notEqual(ta.taskId,tb.taskId);
    const complete = async (client, id) => {
      let result;
      for (let attempt = 0; attempt < 10; attempt++) {result = await client.call('wait_task', {taskId:id,waitSeconds:2});if (!result.timedOut) break;}
      assert.equal(result.state,'completed');assert.equal(result.report.result,'Synthetic success');return result;
    };
    const done = await complete(ca, ta.taskId);await complete(cb, tb.taskId);
    assert.deepEqual((await ca.call('list_tasks')).tasks.map(t => t.taskId), [ta.taskId]);
    assert.deepEqual((await cb.call('list_tasks')).tasks.map(t => t.taskId), [tb.taskId]);
    for (const name of ['get_task','wait_task','continue_task','cancel_task','close_task'])
      await assert.rejects(ca.call(name, {taskId:tb.taskId,...(['continue_task','cancel_task'].includes(name)?{requestId:'synthetic-foreign'}:{}),...(name==='continue_task'?{clarification:'Synthetic forbidden'}:{})}), /unknown_task/);
    await assert.rejects(ca.call('wait_tasks', {taskIds:[ta.taskId,tb.taskId],waitSeconds:1}), /unknown_task/);
    await ca.call('continue_task', {taskId:ta.taskId,requestId:'synthetic-followup',clarification:'Synthetic continuation'});
    assert.equal((await complete(ca, ta.taskId)).chatId, done.chatId);
    assert.equal((await ca.call('close_task', {taskId:ta.taskId})).chatClosed,false);
    fs.renameSync(installed.configPath, installed.configPath + '.hidden');
    await assert.rejects(cb.call('submit_task', {...args,requestId:'synthetic-no-provider',projectDirectory:a}), /action_required \(PROVIDER_NOT_CONFIGURED\)/);
    assert.equal((await cb.call('list_tasks')).tasks.length,1, 'Rejected submission is not persisted');
    assert.deepEqual(JSON.parse(fs.readFileSync(audit)), {ephemeral:true});
    await ca.close();await cb.close();
    await eventually(() => !fs.existsSync(path.join(root,'bridge.json')));
    await eventually(async () => (await processIdentityAsync(owner.pid)).state === 'dead');owner = null;
    console.log('PASS service E2E: stable stdio launcher, concurrent demand-start, real IPC, fake provider/CLI, two-space isolation, wait/continue/close, missing provider and idle process exit.');
  } finally {
    for (const client of clients) {if (client.child.exitCode === null) client.child.kill();await client.closed;}
    owner ||= readDiscovery(locations({root}));
    if (owner) {
      const current = await processIdentityAsync(owner.pid);
      if (current.state === 'alive' && current.processStart === owner.processStart) {process.kill(owner.pid);await eventually(async () => (await processIdentityAsync(owner.pid)).state === 'dead');}
    }
    assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-e2e-synthetic-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
