// Synthetic service + two independent window clients. No VS Code or real account.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {pathToFileURL} = require('node:url');
const {runService} = require('../runtime/service-main.cjs');
const {connectService} = require('../runtime/service-endpoint.cjs');
const {ServiceWindowClient} = require('../runtime/service-window-client.cjs');
const {fixture} = require('./service-fixture.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!check()) {assert(Date.now() < deadline, 'Synthetic condition timed out'); await pause(20);}
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-window-synthetic-'));
  const data = fixture(root), clients = [], peers = []; let service, answers = 0, pendingTask;
  const a = path.join(root, 'synthetic-a'), b = path.join(root, 'synthetic-b');
  for (const folder of [a,b]) {fs.mkdirSync(folder); fs.mkdirSync(path.join(folder,'.git'));}
  const sub = path.join(a,'synthetic-sub'); fs.mkdirSync(sub);
  const window = folders => {
    const client = new ServiceWindowClient({root, trusted:true, workspaceFolders:folders.map(folder => pathToFileURL(folder).href)});
    clients.push(client); return client;
  };
  const adapter = async folder => {
    const peer = await connectService({root, hello:{clientKind:'adapter', binding:{source:'cwd', launchDirectory:folder}}});
    peers.push(peer); return peer;
  };
  const call = async (peer, name, args) => {
    const value = await peer.call('task.call',{bindingId:peer.binding.bindingId, spaceId:peer.binding.spaceId, name, arguments:args});
    if (value.error) throw Object.assign(Error(value.error.message),value.error); return value.result;
  };
  try {
    // Routing of answers is synthetic; executor/CLI approval validation has its own suites.
    service = await runService({root, hostOptions:{...data.hostOptions, decorateAdapter:adapter => {
      const pending = adapter.pending;
      adapter.pending = task => task.taskId === pendingTask ? [{id:'synthetic-question',method:'item/tool/requestUserInput',params:{}}] : pending(task);
      const answer = adapter.answer;
      adapter.answer = async (task, approval) => {
        if (task.taskId !== pendingTask) return answer(task, approval);
        assert.deepEqual(approval.answers, {'synthetic-question':'Synthetic answer'}); answers++; pendingTask = null;
      };
      return adapter;
    }}});
    const pa = await adapter(a), pb = await adapter(b);
    const wa = window([a,sub]), wb = window([b]);
    await Promise.all([wa.start(),wb.start()]);
    assert.equal(wa.spaces.length,1,'Same repository roots collapse');
    const sa = wa.spaces[0].spaceId, sb = wb.spaces[0].spaceId;
    assert.notEqual(sa,sb); assert.equal(sa,pa.binding.spaceId);
    const ta = await call(pa,'submit_task',{requestId:'synthetic-a',description:'Synthetic A',acceptanceCriteria:'Synthetic checks',projectDirectory:a});
    const tb = await call(pb,'submit_task',{requestId:'synthetic-b',description:'Synthetic B',acceptanceCriteria:'Synthetic checks',projectDirectory:b});
    await until(() => wa.snapshots.get(sa)?.tasks[0]?.state === 'completed' && wb.snapshots.get(sb)?.tasks[0]?.state === 'completed');
    assert.deepEqual(wa.snapshots.get(sa).tasks.map(task=>task.taskId),[ta.taskId]);
    assert.deepEqual(wb.snapshots.get(sb).tasks.map(task=>task.taskId),[tb.taskId]);
    assert.equal(wa.snapshots.get(sa).tasks[0].report.result,'Synthetic success','Panel projection includes final report');
    const huge={result:'😀'.repeat(10000),changedFiles:Array(20).fill('😀'.repeat(1000)),checks:['Synthetic check'],remainingIssues:[]};
    const bounded=require('../runtime/service-projection.cjs').report(huge);
    assert(bounded.truncated);assert(Buffer.byteLength(JSON.stringify(bounded))<4096);assert(!bounded.result.includes('\ufffd'));
    assert.equal(huge.result.length,20000,'Display clipping does not change durable report');
    assert.deepEqual(wa.snapshots.get(sa).windows.map(row=>row.windowId),[wa.windowId]);
    // No foreign tasks, presence or spaces can be queried through a window binding.
    assert.equal(wa.snapshots.get(sa).windows.length,1);
    await assert.rejects(wa.call(sb,'get_task',{taskId:tb.taskId}),{code:'space_not_bound'});
    await assert.rejects(wa.call(sa,'get_task',{taskId:tb.taskId}),{code:'unknown_task'});
    assert.equal((await wa.peer.call('space.subscribe',{bindingId:wa.peer.binding.bindingId,spaceId:sb})).error.code,'space_not_bound');
    assert.equal((await pa.call('space.subscribe',{bindingId:pa.binding.bindingId,spaceId:sa})).error.code,'invalid_argument');

    const oldB = wb.peer;
    wa.close(); assert.equal(wa.snapshots.size,0);
    const reloaded = window([a]); await reloaded.start();
    assert.equal(wb.peer,oldB,'Reloading A preserves B connection');
    assert.equal(reloaded.snapshots.get(sa).tasks[0].taskId,ta.taskId,'Reload obtains full history');
    await reloaded.call(sa,'continue_task',{requestId:'synthetic-window-followup',taskId:ta.taskId,clarification:'Synthetic followup'});
    await until(() => reloaded.snapshots.get(sa)?.tasks[0]?.state === 'completed');
    assert.equal((await reloaded.call(sa,'get_task',{taskId:ta.taskId})).chatId,ta.chatId || service.host.mcp.tasks.tasks.get(ta.taskId).chatId);

    const task = service.host.mcp.tasks.tasks.get(ta.taskId);
    const revision = reloaded.snapshots.get(sa).viewRevision;
    const listener = reloaded.peer.listeners('event')[0]; reloaded.peer.removeListener('event',listener);
    task.progress = 'Synthetic skipped event one'; service.host.mcp.tasks.save(task);
    task.progress = 'Synthetic skipped event two'; service.host.mcp.tasks.save(task);
    await pause(40); reloaded.peer.on('event',listener);
    task.progress = 'Synthetic full resync'; service.host.mcp.tasks.save(task);
    await until(() => reloaded.snapshots.get(sa)?.tasks[0]?.progress === task.progress);
    assert(reloaded.snapshots.get(sa).viewRevision >= revision + 3,'Event gap causes full replacement');

    const beforeReconnect = reloaded.peer;
    beforeReconnect.close();
    await until(() => reloaded.peer && reloaded.peer !== beforeReconnect && reloaded.snapshots.has(sa));
    assert.equal(wb.peer,oldB,'Reconnect of A preserves B');
    assert.equal(reloaded.snapshots.get(sa).tasks[0].taskId,ta.taskId);

    pendingTask = ta.taskId; task.state = 'waiting_approval'; service.host.mcp.tasks.save(task);
    await assert.rejects(wb.call(sb,'continue_task',{requestId:'synthetic-foreign-answer',taskId:ta.taskId,approval:{id:'synthetic-question'}}),{code:'unknown_task'});
    const approval = {requestId:'synthetic-window-answer',taskId:ta.taskId,approval:{id:'synthetic-question',answers:{'synthetic-question':'Synthetic answer'}}};
    await reloaded.call(sa,'continue_task',approval); await reloaded.call(sa,'continue_task',approval);
    assert.equal(answers,1,'Explicit same-ID retry answers once');
    // Restore synthetic terminal state: the fake answer did not start a CLI turn.
    task.state = 'completed'; service.host.mcp.tasks.save(task);

    const request = reloaded.peer.call.bind(reloaded.peer); let dispatches = 0;
    reloaded.peer.call = async (...args) => {
      if (args[0] !== 'task.call') return request(...args);
      dispatches++; await request(...args); throw Object.assign(Error('Synthetic lost ACK'),{code:'rpc_timeout'});
    };
    await assert.rejects(reloaded.call(sa,'cancel_task',{requestId:'synthetic-lost-ack',taskId:ta.taskId}),{code:'rpc_timeout'});
    reloaded.peer.call = request; assert.equal(dispatches,1,'Mutation failure is never automatically replayed');

    const multi = window([a,b]); await multi.start(); assert.equal(multi.snapshots.size,2);
    assert(multi.snapshots.get(sa).windows.length >= 2);
    assert(!multi.snapshots.get(sa).windows.some(row=>row.windowId===wb.windowId));
    service.host.mcp.tasks.keepClosed = 0;
    await reloaded.call(sa,'close_task',{taskId:ta.taskId});
    assert(!service.host.mcp.tasks.tasks.has(ta.taskId),'Closed task moved into archive');
    await reloaded.refresh(sa);
    assert.equal(reloaded.snapshots.get(sa).totalTasks,1,'Archive remains part of total history');
    assert.equal(reloaded.snapshots.get(sa).tasks[0].taskId,ta.taskId,'Recent archive summaries stay visible');
    const extra = await call(pa,'submit_task',{requestId:'synthetic-a-extra',description:'Synthetic extra',acceptanceCriteria:'Synthetic checks',projectDirectory:a});
    const limited = await reloaded.peer.call('space.subscribe',{bindingId:reloaded.peer.binding.bindingId,spaceId:sa,limit:1});
    assert.equal(limited.result.totalTasks,2); assert.equal(limited.result.hasMoreHistory,true);
    assert.equal(limited.result.tasks[0].taskId,extra.taskId,'Active tasks precede archived history');
    await reloaded.call(sa,'cancel_task',{requestId:'synthetic-cancel-extra',taskId:extra.taskId});
    const archive=service.host.mcp.tasks.archive;
    archive.records=()=>{throw Error('Synthetic full archive scan forbidden');};
    await reloaded.refresh(sa);assert.equal(reloaded.snapshots.get(sa).totalTasks,2);
    fs.writeFileSync(archive.store.file('mcp-task',ta.taskId),'{');
    await reloaded.refresh(sa);
    assert.equal(reloaded.snapshots.get(sa).tasks.some(task=>task.taskId===ta.taskId),false,'Corrupt archive record is skipped by space.subscribe');
    assert.equal(reloaded.snapshots.get(sa).totalTasks,1);await wb.refresh(sb);assert.equal(wb.snapshots.get(sb).totalTasks,1,'Corrupt A history does not affect B');
    const empty = window([]); await empty.start(); assert.equal(empty.snapshots.size,0);
    assert.throws(()=>new ServiceWindowClient({trusted:false,workspaceFolders:['synthetic-invalid-uri']}),{code:'workspace_untrusted'});
    for (const [binding,code] of [
      [{trusted:false,workspaceFolders:['synthetic-invalid-uri'],windowId:'synthetic-untrusted'},'workspace_untrusted'],
      [{trusted:true,workspaceFolders:['vscode-remote://synthetic/folder'],windowId:'synthetic-remote'},'space_unsupported_uri'],
    ]) await assert.rejects(connectService({root,hello:{clientKind:'window',binding}}),{code});
    console.log('PASS service windows: trusted multi-root binding, A/B isolation, snapshots/events/gap resync, reload/reconnect, continuation/answer routing, no mutation replay.');
  } finally {
    for (const client of clients) client.close(); for (const peer of peers) peer.close();
    await service?.shutdown(); await data.close();
    assert.equal(path.dirname(root),os.tmpdir()); assert(path.basename(root).startsWith('rundix-window-synthetic-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
