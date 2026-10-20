// Synthetic only: no CLI, account files, inference or real child processes.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {McpTasks}=require('../runtime/mcp-tasks.cjs');
const {executor}=require('../runtime/mcp-executor.cjs');
const {notification}=require('../runtime/session.cjs');
const {SessionStore}=require('../runtime/store.cjs');
const {canonical}=require('../runtime/task-directory.cjs');

const noop=async()=>{};
async function transitions(root,project) {
  let status={done:false,pending:false},releaseFailure=null;
  const released=[];
  const adapter={connection:()=>({id:'synthetic-companion'}),assertConnection(){},pending:()=>[],chatId:()=> 'synthetic-thread',
    start:noop,cancel:noop,answer:noop,status:async()=>status,
    release(task){released.push([task.taskId,task.state,task.recoveryRequired]);if(releaseFailure==='sync')throw Error('Synthetic release failure');if(releaseFailure==='async')return Promise.reject(Error('Synthetic release failure'));}};
  const tasks=new McpTasks({store:new SessionStore(path.join(root,'tasks')),adapter});tasks.schedule=()=>{};
  const task={taskId:'synthetic-task',sessionKey:'synthetic-session',state:'running',projectDirectory:project,operations:[],connection:adapter.connection(),createdAt:1};
  tasks.tasks.set(task.taskId,task);
  try {
    status={done:false,pending:true};await tasks.tick();assert.equal(task.state,'waiting_approval');assert.equal(released.length,0);
    task.continuations=['Synthetic continuation'];status={done:true,report:{result:'Synthetic result'}};
    await tasks.tick();await tasks.idle();assert.equal(task.state,'running');assert.equal(released.length,0,'Queued continuations keep the thread subscribed');
    for(const [expected,flags,failure] of [['completed',{},null],['error',{failed:true},'async'],['cancelled',{cancelled:true},'sync']]) {
      task.state='running';task.recoveryRequired=true;releaseFailure=failure;status={done:true,...flags,report:{result:'Synthetic result'}};
      const before=released.length;
      await tasks.tick();await new Promise(resolve=>setImmediate(resolve));
      assert.equal(task.state,expected);assert.equal(task.recoveryRequired,false);assert.equal(task.report.result,'Synthetic result');
      assert.deepEqual(released.at(-1),[task.taskId,expected,false]);assert.equal(released.length,before+1);
      await tasks.tick();tasks.save(task);assert.equal(released.length,before+1,'Terminal observations and saves do not release twice');
    }
    task.state='running';adapter.status=async()=>{throw Error('Synthetic unavailable status');};
    const before=released.length;await tasks.tick();assert.equal(task.state,'error');assert.equal(task.recoveryRequired,true);assert.equal(released.length,before,'Ambiguous execution must stay loaded for recovery');
    adapter.status=async()=>({done:true});task.state='queued';task.cancelRequested=true;
    await tasks.tick();assert.equal(task.state,'cancelled');assert.equal(released.length,before+1,'Confirmed recovery cancellation releases too');
    task.state='queued';task.cancelRequested=false;task.recoveryRequired=false;
    tasks.call('cancel_task',{taskId:task.taskId,requestId:'synthetic-cancel-queued'});
    assert.equal(task.state,'cancelled');assert.equal(released.length,before+2);
    task.state='queued';task.cancelRequested=true;task.awaitingPreparation=true;adapter.start=async()=>{task.awaitingPreparation=true;throw Error('Synthetic cancelled preparation');};
    await tasks.start(task);assert.equal(task.state,'cancelled');assert.equal(released.length,before+3);
  } finally {tasks.dispose();}
}
async function reload(root,project) {
  const store=new SessionStore(path.join(root,'sessions')),connection={id:'synthetic-companion',owner:'synthetic-owner',revision:'synthetic-revision'};
  const s={key:'synthetic-session',id:'synthetic-thread',cwd:project,loaded:true,busy:false,model:'synthetic-model',prefs:{},attachments:[],
    panel:{visible:true},draft:'Synthetic preserved draft',items:[{id:'synthetic-report',type:'agentMessage',text:'Synthetic cached result'}]};
  const other={key:'synthetic-other-session',id:'synthetic-other-thread',loaded:true,items:[]};
  const sessions=new Map([[s.key,s],[other.key,other]]),pending=new Map(),threadReleases=new Map(),requests=[],turnLeases=new Map();
  let finishRelease,releaseFailure=false,selected=connection;
  const server={request:async(method,params)=>{
    requests.push({method,params});
    if(method==='thread/unsubscribe') {if(releaseFailure)throw Error('Synthetic RPC failure');await new Promise(resolve=>{finishRelease=resolve;});return {status:'unsubscribed'};}
    if(method==='thread/resume')return {thread:{cwd:project,status:{type:'idle'},name:'Synthetic thread'},model:'synthetic-model'};
    if(method==='thread/turns/list')return {data:[{id:'synthetic-previous-turn',status:'completed'}]};
    if(method==='thread/items/list')return {data:s.items};
    if(method==='turn/start')return {turn:{id:'synthetic-next-turn'}};
    throw Error('Unexpected synthetic method');
  }};
  const context={threadReleases,mcpThreadConfig:()=>null,connect:noop,sessions,server,save:noop,publish(){},select(){throw Error('Unexpected synthetic select');},
    readItem:require('../runtime/session.cjs').readItem,questionRecords:{restore(){}},authBusy:false,store,
    taskDirectory:require('../runtime/task-directory.cjs'),cwd:()=>project,locale:{t:text=>text},vscode:{workspace:{isTrusted:true}},
    syncExternal:noop,applyPendingMode:noop,accountReadRevision:1,activeConnection:{},connections:{assertCurrent(){}},
    refreshAccount:async()=>false,account:{},limits:{updatedAt:Date.now(),buckets:[{id:'codex',windows:[{remaining:100}]}]},limitsRequest:null,refreshLimits:noop,refreshCatalog:noop,catalogUpdatedAt:Date.now(),
    updateDraftModel(){},
    catalog:[{model:'synthetic-model',supportedReasoningEfforts:[]}],preflight:{preparing:()=>false},
    modes:{current:()=>({id:'workspace'}),policy:()=>({})},speed:{effectiveTier:()=> 'default'},buildInput:text=>[{type:'text',text}],turnLeases};
  context.resumeThread=(...args)=>require('../runtime/session-resume.cjs').resumeThread(context,...args);
  context.resume=(...args)=>require('../runtime/session-resume.cjs').resume(context,...args);
  const send=(...args)=>require('../runtime/send-queue.cjs').send(context,...args);
  const task={taskId:'synthetic-task',sessionKey:s.key,chatId:s.id,projectDirectory:project,connection};
  const adapter=executor({connections:{selection:()=>selected},sessions,store,pending,client:()=>server,releases:threadReleases,
    create(){throw Error('Release must not reopen a tab');},send,resume:context.resume,save:noop,alive:()=>true});
  s.lastTurnStatus='completed';
  for(const flag of ['sendingTask','modeChange','compacting','followUpSending','asyncQuestionSending']) {
    s[flag]=true;assert.equal((await adapter.status(task)).done,false,flag+' delays the terminal transition');s[flag]=false;
  }
  assert.equal((await adapter.status(task)).done,true,'A later poll finishes after transient operations settle');
  for(const flag of ['busy','sendingTask','loading','compacting','followUpSending','asyncQuestionSending','modeChange']) {
    s[flag]=true;await adapter.release(task);s[flag]=false;assert.equal(requests.length,0,flag+' prevents release');
  }
  pending.set('synthetic-request',{id:'synthetic-request',params:{threadId:s.id}});
  await adapter.release(task);assert.equal(requests.length,0);pending.clear();
  const tasks=new McpTasks({store:new SessionStore(path.join(root,'mode-tasks')),adapter});tasks.schedule=()=>{};
  Object.assign(task,{state:'running',operations:[],createdAt:1});tasks.tasks.set(task.taskId,task);
  let finishMode;s.modeChange=new Promise(resolve=>{finishMode=resolve;});
  await tasks.tick();assert.equal(task.state,'running');assert.equal(requests.length,0);
  finishMode();await s.modeChange;s.modeChange=null;
  const cached=s.items;await tasks.tick();tasks.dispose();
  const release=threadReleases.get(s.id);
  assert.equal(task.state,'completed');assert(release,'Settled mode change must lead to terminal cleanup on the next poll');
  assert.equal(s.loaded,false);assert.equal(other.loaded,true);assert.equal(s.items,cached);assert.equal(s.draft,'Synthetic preserved draft');
  assert.equal(adapter.release(task),release,'Concurrent cleanup shares one RPC');
  const nextSend=send(s,'Synthetic next input',[],{includeIde:false});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests.map(r=>r.method),['thread/unsubscribe'],'Send waits until unsubscribe finishes');
  assert.equal(requests[0].params.threadId,s.id);
  assert.equal(notification(s,{method:'thread/closed',params:{threadId:other.id}}),false);
  assert.equal(notification(s,{method:'thread/closed',params:{threadId:s.id}}),true);assert.equal(s.loaded,false);assert.equal(s.items,cached);
  finishRelease();await release;await nextSend;
  assert.deepEqual(requests.map(r=>r.method),['thread/unsubscribe','thread/resume','thread/turns/list','thread/items/list','turn/start']);
  assert.equal(s.loaded,true);assert.equal(s.busy,true);assert.equal(threadReleases.size,0);
  turnLeases.get(s.id)();turnLeases.clear();s.busy=false;
  // A failed RPC remains safe to reload, including when the response was lost after server-side unload.
  releaseFailure=true;await assert.rejects(adapter.release(task),/Synthetic RPC failure/);assert.equal(s.loaded,false);assert.equal(threadReleases.size,0);
  await context.resume(s,s.id);assert.equal(s.loaded,true);
  // Capture the original server; a late result must not mutate a replacement session or connection.
  releaseFailure=false;const oldRelease=adapter.release(task);await new Promise(resolve=>setImmediate(resolve));
  const replacement={...s,loaded:true};sessions.set(s.key,replacement);selected={...connection,revision:'synthetic-new-revision'};
  finishRelease();await oldRelease;assert.equal(replacement.loaded,true);assert.equal(other.loaded,true);
  assert.throws(()=>adapter.release(task),/different connection/);
  selected=connection;sessions.delete(s.key);store.saveSession(s);
  releaseFailure=true;await assert.rejects(adapter.release(task),/Synthetic RPC failure/);
  assert.equal(sessions.size,1,'Closed chats are released by ID without being reopened');
}
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-release-synthetic-'));
  try {const project=canonical(root);await transitions(root,project);await reload(root,project);
    console.log('MCP release: terminal cleanup once, continuations/approvals/recovery, ignored failures, idle guards, thread/closed and serialized send/resume passed.');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
