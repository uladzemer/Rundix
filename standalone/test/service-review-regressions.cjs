require('./test-isolation.cjs').isolate();
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SessionStore}=require('../runtime/store.cjs');
const {McpTasks}=require('../runtime/mcp-tasks.cjs');
const recovery=require('../runtime/task-recovery.cjs');
const {createHeadlessHost}=require('../runtime/service-headless-host.cjs');
const {createLimitPoller}=require('../runtime/service-limit-poller.cjs');
const {fixture}=require('./service-fixture.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-review-regression-synthetic-'));
const project=name=>{const dir=path.join(root,name);fs.mkdirSync(dir,{recursive:true});return require('../runtime/task-directory.cjs').canonical(dir);};
const connection={id:'synthetic-companion',owner:'synthetic.owner',revision:'synthetic-revision'};
const task=(id,dir)=>({taskId:id,sessionKey:id,description:'Synthetic task',acceptanceCriteria:'Synthetic check',state:'error',recoveryRequired:true,
  space:'synthetic-space',connection,operations:[],projectDirectory:dir,createdAt:Date.now()});
function harness(name,service,adapter,now=Date.now,maxParallel=()=>1){
  const tasks=new McpTasks({store:new SessionStore(path.join(root,name)),scope:service?()=> 'synthetic-space':undefined,now,maxParallel,
    adapter:{connection:()=>connection,assertConnection(){},pending:()=>[],chatId:()=> 'synthetic-thread',cancel:async()=>{},...adapter,limitRecovery:service}});
  tasks.schedule=()=>{};return tasks;
}
async function step(tasks){await tasks.tick();await tasks.idle();}
async function until(host,check){const deadline=Date.now()+10000;while(Date.now()<deadline){await step(host.mcp.tasks);if(check())return;await pause(15);}throw Error('Synthetic review regression deadline: '+JSON.stringify([...host.mcp.tasks.tasks.values()].map(row=>({state:row.state,progress:row.progress,error:row.error,phase:row.deliveryPhase,pending:row.limitContinuation,budget:row.serviceReadiness}))));}

async function queuedInput(){
  for(const service of [false,true]){
    let fail=true,sent=[];
    const tasks=harness('queued-'+service,service,{status:async()=>{if(fail)throw Error('Synthetic unavailable');return {done:true,failed:true};},start:async(_task,input)=>{sent.push(input);}});
    try{
      const row=task('synthetic-queued',project('queued-'+service));tasks.tasks.set(row.taskId,row);tasks.save(row);
      tasks.call('continue_task',{taskId:row.taskId,requestId:'synthetic-continue',clarification:'Synthetic queued input'});
      await step(tasks);assert.equal(row.state,'queued','A failed recovery read must leave queued input queued');
      fail=false;row.blockedUntil=0;if(row.statusRead)row.statusRead.nextAt=0;
      for(let n=0;n<4;n++)await step(tasks);
      assert(sent.includes('Synthetic queued input') || row.unsentInputs?.some(input=>input.text==='Synthetic queued input'));
      row.state='running';row.recoveryRequired=true;row.continuations=['Synthetic FIFO input'];
      await step(tasks);if(service)assert(row.unsentInputs.some(input=>input.text==='Synthetic FIFO input'),'Failed service terminal paths retain FIFO input');
    }finally{tasks.dispose();}
  }
}

async function windowsAndSlowRecovery(){
  let reads=0,fail=true;
  const windows=harness('window-reads',false,{status:async()=>{reads++;if(fail)throw Error('Synthetic status');return {done:true};}});
  try{
    const row=task('synthetic-window',project('window'));row.state='running';windows.tasks.set(row.taskId,row);
    for(let n=0;n<9;n++)await windows.tick();assert.equal(reads,9);assert.equal(row.statusRead,undefined);
    fail=false;await windows.tick();assert.equal(row.recoveryRequired,false,'Window mode automatically retries exactly as before');
  }finally{windows.dispose();}
  let now=100000,starts=0,oldReads=0;
  const service=harness('slow-reads',true,{status:async row=>{if(row.taskId==='synthetic-slow'){oldReads++;return {done:true};}return {done:false};},start:async()=>{starts++;}},()=>now);
  try{
    const old=task('synthetic-slow',project('slow-old'));old.statusRead={failures:6,slow:true,nextAt:now+recovery.SLOW_RETRY_MS};service.tasks.set(old.taskId,old);
    const next=task('synthetic-next',project('slow-next'));next.state='queued';next.recoveryRequired=false;service.tasks.set(next.taskId,next);
    await step(service);assert.equal(starts,1,'Slow recovery does not consume the only runnable slot');assert.equal(oldReads,0);
    now+=recovery.SLOW_RETRY_MS;await step(service);assert.equal(oldReads,1);assert.equal(old.recoveryRequired,false,'The slow retry recovers without explicit user input');
  }finally{service.dispose();}
  const {notification}=require('../runtime/session.cjs');
  const windowSession={id:'synthetic-thread',busy:true,turnId:'synthetic-new',items:[]};
  assert(notification(windowSession,{method:'turn/completed',params:{threadId:windowSession.id,turn:{id:'synthetic-old',status:'completed'}}}));
  assert.equal(windowSession.busy,false);
  const {resumeThread}=require('../runtime/session-resume.cjs');
  for(const serviceMode of [false,true]){
    const s={id:'synthetic-resume',items:[],prefs:{},turnId:'synthetic-preserved',error:'Synthetic preserved error'};
    await resumeThread({serviceMode,threadReleases:new Map(),connect:async()=>{},sessions:new Map(),hasChat:()=>false,mcpThreadConfig:()=>null,
      server:{request:async method=>method==='thread/resume'?{thread:{status:{type:'idle'}}}:method==='thread/turns/list'?{data:[{id:'synthetic-turn',status:'failed',error:{message:'Synthetic new error'}}]}:{data:[]}},
      questionRecords:{restore(){}},readItem:item=>item,save:async()=>{},publish(){}},s,s.id);
    assert.equal(s.error,serviceMode?'Synthetic new error':'Synthetic preserved error');assert.equal(s.turnId,serviceMode?null:'synthetic-preserved');
  }
}

async function lightweightStatus(){
  const {createTaskStatus,STATUS_TIMEOUT_MS,MISSING_EVENTS_MS}=require('../runtime/service-task-status.cjs');
  let now=100000,fail=false,reads=[];
  const s={id:'synthetic-long-thread',key:'synthetic-long',loaded:true,cliGeneration:'synthetic-generation',busy:true,items:[]};
  const row=task('synthetic-long',project('long'));row.state='running';row.lastActivityAt=now;
  const server={request:async(method,params,timeout)=>{
    reads.push({method,params,timeout});if(fail)throw Object.assign(Error('Synthetic long-thread timeout'),{code:'rejected'});
    return method==='thread/read'?{thread:{status:{type:'active'}}}:{data:[{id:'synthetic-active',status:'inProgress'}]};
  }};
  const core={sessions:new Map([[row.sessionKey,s]]),store:{session:()=>s},state:{server},connect:async()=>{},save:async()=>{}};
  const status=createTaskStatus({core,provider:{cli:{binding:{appServerGeneration:'synthetic-generation'}}},now:()=>now,
    status:async()=>({done:!s.busy,chatId:s.id}),runs:new Map(),finishRun(){}});
  await status(row);assert.equal(reads.length,0,'An active task with recent events needs no status RPC');
  now+=MISSING_EVENTS_MS+1;await status(row);
  assert.deepEqual(reads.map(read=>read.method),['thread/read','thread/turns/list']);assert.equal(reads[0].params.includeTurns,false);assert.equal(reads[1].params.limit,1);
  assert(reads.every(read=>read.timeout===STATUS_TIMEOUT_MS));
  fail=true;now+=MISSING_EVENTS_MS+1;await assert.rejects(()=>status(row),{code:'rejected'});
  assert.equal(s.busy,true,'A timed-out long-thread read cannot erase the observed active turn');
  let rejectRead,starts=0;
  const tasks=harness('unblocked-reads',true,{status:async value=>value.taskId===row.taskId?new Promise((_,reject)=>{rejectRead=reject;}):{done:false},start:async()=>{starts++;}},Date.now,()=>2);
  try{
    tasks.tasks.set(row.taskId,row);const next=task('synthetic-independent',project('independent'));next.state='queued';next.recoveryRequired=false;tasks.tasks.set(next.taskId,next);
    await tasks.tick();await Promise.all([...tasks.launches]);assert.equal(starts,1);assert.equal(tasks.executing,false,'A pending status read cannot hold the scheduler');
    rejectRead(Error('Synthetic timeout'));await tasks.idle();assert.equal(row.state,'running');assert.equal(row.error,undefined,'Status timeout does not turn healthy work into an error');
    // A later successful active observation must durably clear slow-read state,
    // even when it causes no visible state/revision change.
    row.pendingIds=[];row.statusRead={failures:6,slow:true,nextAt:0};tasks.save(row);
    const revision=row.revision;tasks.adapter.status=async()=>({done:false});await tasks.observe(row);
    assert.equal(tasks.store.read('mcp-task',row.taskId).statusRead,undefined);assert.equal(row.revision,revision);
  }finally{tasks.dispose();}
  const chatless=task('synthetic-no-thread',project('no-thread'));
  const notSent=createTaskStatus({core:{sessions:new Map(),store:{session:()=>null}},provider:{},status(){throw Error('Must not read CLI');},runs:new Map()});
  assert.equal((await notSent(chatless)).notSent,true);
}

async function repeatedLimit(){
  const directory=project('repeated-limit'),policy=path.join(directory,'synthetic-policy.json');
  let now=Date.now(),host,poller,sends=[];
  const data=fixture(directory,{cliEnv:{RUNDIX_SYNTHETIC_LIMIT_ALWAYS:'1',RUNDIX_SYNTHETIC_TURN_POLICY:policy}});
  const makeCli=data.hostOptions.providerOptions.createCli;
  data.hostOptions.providerOptions.createCli=options=>{const cli=makeCli(options),request=cli.request.bind(cli);cli.request=(method,params,...args)=>{if(method==='turn/start')sends.push(params);return request(method,params,...args);};return cli;};
  try{
    host=await createHeadlessHost({root:directory,generation:'synthetic-repeated',clock:{now:()=>now,setTimeout,clearTimeout},taskOptions:{scope:()=> 'synthetic-space'},...data.hostOptions});
    const submitted=await host.mcp.tasks.call('submit_task',{requestId:'synthetic-limit',description:'Synthetic original',acceptanceCriteria:'Synthetic check',projectDirectory:directory});
    const row=host.mcp.tasks.get(submitted.taskId);await until(host,()=>row.state==='waiting_limit');
    poller=createLimitPoller({host,now:()=>now,pollMs:1000000});await poller.tick();await until(host,()=>row.state==='waiting_limit' && row.autoLimit?.consecutive===1);
    await poller.tick();assert.equal(sends.length,2);now+=59999;await poller.tick();assert.equal(sends.length,2);
    now++;await poller.tick();await until(host,()=>row.state==='waiting_limit' && row.autoLimit?.consecutive===2);
    await poller.tick();assert.equal(row.state,'error');assert.match(row.error,/action_required/);assert.equal(sends.length,3);
    const chatId=row.chatId;assert(sends.every(send=>send.threadId===chatId));assert(sends.slice(1).every(send=>send.input[0].text===recovery.CONTINUE));
    for(let n=0;n<10;n++)await poller.tick();assert.equal(sends.length,3,'Ready snapshots cannot trigger an unbounded model loop');
    fs.writeFileSync(policy,JSON.stringify({limit:false}));
    await host.mcp.tasks.call('continue_task',{taskId:row.taskId,requestId:'synthetic-success',clarification:'Synthetic explicit recovery'});
    await until(host,()=>row.state==='completed');assert.equal(row.autoLimit,undefined,'An intervening successful turn resets the consecutive budget');
  }finally{poller?.dispose();await host?.dispose({force:true});await data.close();}
}

async function historyRecovery(){
  const {history}=require('../runtime/service-task-chat.cjs');let now=100000,fail=true,items=0,unsubscribes=0;
  const tasks=harness('history-records',true,{});
  const row=task('synthetic-archived',project('history'));row.state='completed';row.recoveryRequired=false;row.chatId='synthetic-thread';row.closedAt=Date.now();tasks.tasks.set(row.taskId,row);tasks.save(row);tasks.archive.put(row);tasks.tasks.delete(row.taskId);
  const core={sessions:new Map(),store:{session:()=>({id:row.chatId,prefs:{},items:[]})},connect:async()=>{},resumeOptions:async s=>({threadId:s.id,excludeTurns:true,config:{model:'synthetic-model'}}),state:{server:{request:async method=>{
    if(method==='thread/unsubscribe'){unsubscribes++;return {};}
    if(method==='thread/resume')return {thread:{status:{type:'idle'}}};
    items++;if(fail)throw Object.assign(Error('Synthetic history failure'),{code:'rejected'});await pause(15);return {data:[]};
  }}}};
  tasks.adapter.ensureConnection=async()=>{};
  const read=()=>history({core,tasks,task:tasks.get(row.taskId),cursor:'@latest',now:()=>now});
  try{
    for(let n=0;n<6;n++){await assert.rejects(read());const count=items;await assert.rejects(read(),{code:'connection_unavailable'});assert.equal(items,count);now+=60000;}
    fail=false;await assert.rejects(read(),{code:'connection_unavailable'});now+=recovery.SLOW_RETRY_MS;
    const before=items;await Promise.all([read(),read(),read()]);assert.equal(items,before+1,'Concurrent archive history calls share a read');assert(unsubscribes>=7);
    fail=true;await assert.rejects(read());fail=false;
    tasks.call('cancel_task',{taskId:row.taskId,requestId:'synthetic-history-cancel'});
    assert(Array.isArray((await read()).items),'Cancel resets the archived history retry budget');
    let connections=0;
    tasks.adapter.ensureConnection=async()=>{connections++;throw Object.assign(Error('Synthetic disconnected'),{code:'connection_unavailable'});};
    await assert.rejects(read());await assert.rejects(read());await assert.rejects(read());
    assert.equal(connections,1,'Connection failures use the same history backoff as failed RPC reads');
  }finally{tasks.dispose();}
}

async function preparingRestart(){
  for(const automatic of [false,true]){
    const name='preparing-restart-'+automatic,dir=project(name),input=automatic?recovery.CONTINUE:'Synthetic unsent continuation';
    let sent=[];
    const before=harness(name,true,{});
    const row=task('synthetic-preparing',dir);
    Object.assign(row,{state:'running',deliveryPhase:'preparing',nextInput:input,queuedRecoveryInput:true,chatId:'synthetic-thread'});
    if(automatic)row.limitContinuation={state:'pending',exhaustedTurnId:'synthetic-old-limit'};
    before.tasks.set(row.taskId,row);before.save(row);before.dispose();
    const restored=harness(name,true,{status:async()=>({done:true,failed:automatic,exhaustedTurnId:automatic?'synthetic-old-limit':undefined}),
      start:async()=>{sent.push(input);}});
    try{
      const saved=restored.get(row.taskId);await restored.observe(saved);
      assert.equal(saved.nextInput,input);assert.equal(saved.recoveryRequired,false);
      if(automatic){assert.equal(saved.state,'waiting_limit');assert.equal(saved.limitContinuation.state,'pending');}
      else {assert.equal(saved.state,'queued');await step(restored);assert.deepEqual(sent,[input]);}
    }finally{restored.dispose();}
  }
  // The first, generated task input is durable too, before a thread even exists.
  let persisted,starts=0;
  const tasks=harness('initial-preparing',true,{status:async()=>({done:true,failed:true,notSent:true}),start:async row=>{starts++;persisted=tasks.store.read('mcp-task',row.taskId);throw {notSent:true,retryable:true};}});
  try{
    const row=task('synthetic-initial',project('initial-preparing'));row.state='queued';row.recoveryRequired=false;tasks.tasks.set(row.taskId,row);
    await step(tasks);assert.equal(persisted.deliveryPhase,'preparing');assert.match(persisted.nextInput,/Synthetic task/);assert(persisted.queuedRecoveryInput);
    row.chatId=null;row.state='running';row.recoveryRequired=true;
    await tasks.observe(row);assert.equal(row.state,'error');assert.equal(row.recoveryRequired,false);assert(row.unsentInputs.some(input=>input.text===persisted.nextInput));
    const revision=row.revision;for(let n=0;n<10;n++)await step(tasks);assert.equal(starts,1);assert.equal(row.revision,revision,'A never-dispatched chatless task has a definite recoverable outcome');
  }finally{tasks.dispose();}
}

async function generationAndPredispatchExit(exit){
  const directory=project(exit?'predispatch-exit':'generation-change'),data=fixture(directory,{cliEnv:exit?{RUNDIX_SYNTHETIC_LIMIT_ONCE:'1'}:{}});
  let host,poller,killed=false,sends=[],resumes=[];
  const makeCli=data.hostOptions.providerOptions.createCli;
  data.hostOptions.providerOptions.createCli=options=>{
    const cli=makeCli(options),request=cli.request.bind(cli);
    cli.request=async(method,params,...args)=>{
      if(method==='turn/start')sends.push(params);
      const result=await request(method,params,...args);
      if(method==='thread/resume' && host?.provider.activeTurns){
        resumes.push(params);
        if(exit && !killed){killed=true;await cli.stop();throw Object.assign(Error('Synthetic exit before dispatch'),{notSent:true,deliveryUncertain:false});}
      }
      return result;
    };return cli;
  };
  try{
    host=await createHeadlessHost({root:directory,generation:'synthetic-generation-test',taskOptions:{scope:()=> 'synthetic-space'},...data.hostOptions});
    const submitted=await host.mcp.tasks.call('submit_task',{requestId:'synthetic-generation',description:'Synthetic original',acceptanceCriteria:'Synthetic check',projectDirectory:directory});
    const row=host.mcp.tasks.get(submitted.taskId);await until(host,()=>row.state===(exit?'waiting_limit':'completed'));
    const chatId=row.chatId,old=host.provider.cli.binding.appServerGeneration;
    await host.provider.configureByClient({clientId:'synthetic-client',operationId:'synthetic-configure',expectedSelectionRevision:1,action:'synthetic',payload:{scenario:'prepare-reconnect'}});
    if(exit){row.state='queued';row.waitingLimit=null;host.mcp.tasks.save(row);}
    else await host.mcp.tasks.call('continue_task',{taskId:row.taskId,requestId:'synthetic-generation-continue',clarification:'Synthetic continuation'});
    if(exit){
      await until(host,()=>killed && !host.mcp.tasks.starting.size);
      assert.equal(sends.length,1,'A child exit before dispatch must not consume the pending continuation');
      assert.equal(row.limitContinuation.state,'pending');assert.equal(row.nextInput,recovery.CONTINUE);assert(!row.autoLimit?.consecutive);
      row.blockedUntil=0;
      if(row.state==='waiting_limit'){poller=createLimitPoller({host,pollMs:1000000});await poller.tick();}
    }
    await until(host,()=>row.state==='completed');
    assert.notEqual(host.provider.cli.binding.appServerGeneration,old);assert.equal(sends.length,2);assert(sends.every(send=>send.threadId===chatId));
    assert(resumes.length);const expected=await host.core.resumeOptions(host.core.sessions.get(row.sessionKey),chatId);
    assert.deepEqual(resumes[0],expected,'Replacement app-server resumes with the same MCP configuration');
  }finally{poller?.dispose();await host?.dispose({force:true});await data.close();}
  const {resumeOptions}=require('../runtime/session-resume.cjs');
  assert.deepEqual(await resumeOptions({mcpThreadConfig:()=>({synthetic:true}),preparationConfig:async()=>({synthetic:'restricted'}),preflight:{preparing:()=>true}},
    {preflight:{enabled:true}},'synthetic-thread'),{threadId:'synthetic-thread',excludeTurns:true,config:{synthetic:'restricted'},sandbox:'read-only',approvalPolicy:'never'});
}

(async()=>{try{await queuedInput();await windowsAndSlowRecovery();await lightweightStatus();await repeatedLimit();await historyRecovery();await preparingRestart();await generationAndPredispatchExit(false);await generationAndPredispatchExit(true);
 console.log('PASS review regressions: unchanged window recovery, lossless preparing restart, slow retries/free slots, lightweight status, bounded limits, concurrent history, generation config and CLI exit before dispatch.');
}finally{assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-review-regression-synthetic-'));fs.rmSync(root,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
