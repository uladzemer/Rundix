require('./test-isolation.cjs').isolate();
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SessionStore}=require('../runtime/store.cjs');
const {McpTasks}=require('../runtime/mcp-tasks.cjs');
const recovery=require('../runtime/task-recovery.cjs');
const inputRecovery=require('../runtime/mcp-input-recovery.cjs');
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
async function until(host,check,waitForIdle=true){const deadline=Date.now()+10000;while(Date.now()<deadline){await host.mcp.tasks.tick();if(waitForIdle)await host.mcp.tasks.idle();if(check())return;await pause(15);}throw Error('Synthetic review regression deadline: '+JSON.stringify([...host.mcp.tasks.tasks.values()].map(row=>({state:row.state,progress:row.progress,error:row.error,phase:row.deliveryPhase,pending:row.limitContinuation,budget:row.serviceReadiness}))));}

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
      assert(sent.includes('Synthetic queued input'),'Queued input is sent once status is readable again');
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
  assert.equal(notification(windowSession,{method:'turn/completed',params:{threadId:windowSession.id,turn:{id:'synthetic-old',status:'completed'}}}),false);
  assert.equal(windowSession.busy,true,'An old completion cannot stop the newer turn or arm capacity recovery');
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
    // The cap stops only the fixed continuation: the client's own input is still sent.
    await host.mcp.tasks.call('continue_task',{taskId:row.taskId,requestId:'synthetic-manual-after-cap',clarification:'Synthetic manual after cap'});
    await until(host,()=>sends.length===4);assert.equal(sends[3].input[0].text,'Synthetic manual after cap');assert.equal(sends[3].threadId,chatId);
    await until(host,()=>row.state==='waiting_limit');assert.equal(row.limitContinuation.state,'pending');
    fs.writeFileSync(policy,JSON.stringify({limit:false}));
    await host.mcp.tasks.call('continue_task',{taskId:row.taskId,requestId:'synthetic-success',clarification:'Synthetic explicit recovery'});
    assert.equal(row.continuations.at(-1),'Synthetic explicit recovery','Client input waits FIFO behind the pending continuation');
    await poller.tick();
    await until(host,()=>row.state==='completed');assert.equal(row.autoLimit,undefined,'An intervening successful turn resets the consecutive budget');
  }finally{poller?.dispose();await host?.dispose({force:true});await data.close();}
}

async function exitDuringLimit(kind){
  const directory=project(kind),gate=path.join(directory,'synthetic-dispatch-gate');
  const automatic=kind!=='clarification-at-limit', nextLimit=kind!=='automatic-exit-without-limit';
  const data=fixture(directory,{cliEnv:{RUNDIX_SYNTHETIC_DISPATCH_GATE:gate,...(automatic?{RUNDIX_SYNTHETIC_LIMIT_ONCE:'1'}:{})}});
  const makeCli=data.hostOptions.providerOptions.createCli,sent=[];
  let now=Date.now(),host,poller,held;
  const lostAck=()=>Object.assign(Error('Synthetic lost ACK'),{deliveryUncertain:true});
  data.hostOptions.providerOptions.createCli=options=>{
    const cli=makeCli(options),request=cli.request.bind(cli);
    cli.request=async(method,params,...args)=>{
      if(method!=='turn/start')return request(method,params,...args);
      sent.push(params.input[0].text);
      const attempt=sent.length,result=await request(method,params,...args);
      if(attempt!==(automatic?2:1))return result;
      // Hold the RPC response at the transport boundary while the real synthetic turn is live.
      return new Promise((_,reject)=>{held={cli,turnId:result.turn.id,reject};});
    };return cli;
  };
  try{
    host=await createHeadlessHost({root:directory,generation:'synthetic-'+kind,clock:{now:()=>now,setTimeout,clearTimeout},taskOptions:{scope:()=> 'synthetic-space'},...data.hostOptions});
    const tasks=host.mcp.tasks;tasks.schedule=()=>{};
    if(!automatic)fs.writeFileSync(gate,'ack');
    const {taskId}=await tasks.call('submit_task',{requestId:'synthetic-exit-limit',description:'Synthetic limit task',acceptanceCriteria:'Synthetic check',projectDirectory:directory});
    const row=tasks.get(taskId),recoveryTexts=()=>tasks.call('get_task',{taskId}).unsentInputs.map(item=>item.text);
    let firstLimit;
    if(automatic){
      await until(host,()=>row.state==='waiting_limit');
      firstLimit=row.limitContinuation.exhaustedTurnId;
      fs.writeFileSync(gate,'ack');
      poller=createLimitPoller({host,now:()=>now,pollMs:1000000});
      await poller.tick();
      if(nextLimit){
        const write=tasks.store.write.bind(tasks.store);
        let beforeDispatch;
        tasks.store.write=(type,id,value)=>{
          if(!beforeDispatch && type==='mcp-task' && id===taskId && value.deliveryPhase==='dispatching'){
            beforeDispatch=tasks.store.read(type,id);
            throw Error('Synthetic dispatch checkpoint write failure');
          }
          return write(type,id,value);
        };
        await until(host,()=>beforeDispatch && row.state==='queued');
        const afterFailure=tasks.store.read('mcp-task',taskId);
        for(const key of ['nextInput','queuedRecoveryInput','deliveryPhase','lastActivityAt','limitContinuation','autoLimit'])
          assert.deepEqual(afterFailure[key],beforeDispatch[key],key+' survives the failed checkpoint');
        assert.equal(afterFailure.revision,beforeDispatch.revision+1,'Only the retry state advances the revision');
        assert.equal(sent.length,1,'The failed checkpoint did not send');
        row.blockedUntil=0;
      }
    }
    await until(host,()=>held && host.core.sessions.get(row.sessionKey)?.lastStartedTurnId===held.turnId,false);
    assert.equal(row.deliveryPhase,'dispatching');
    const clarification='Synthetic queued clarification at limit';
    if(automatic){
      assert.equal(row.limitContinuation.state,'dispatching');
      assert.equal(row.autoLimit.consecutive,1);
      assert.equal(sent.at(-1),recovery.CONTINUE);
    }else{
      const checkpoint=tasks.store.read('mcp-task',taskId);
      const attemptId=checkpoint.inputAttempt.id;
      assert.equal(checkpoint.unsentInputs[0].id,attemptId,'The attempt and text share the dispatch checkpoint');
      assert.equal(checkpoint.unsentInputs[0].possiblyNotDelivered,true);
      assert.deepEqual(recoveryTexts(),[],'An in-flight attempt is invisible in its own process');
      assert.equal(tasks.call('get_task',{taskId,brief:true}).unsentInputCount,0);
      held.reject(lostAck());await tasks.idle();
      assert.equal(row.state,'error');assert.equal(row.recoveryRequired,true);
      assert.equal(host.provider.cli,held.cli,'The uncertain turn still owns the live CLI');
      const continued=await tasks.call('continue_task',{taskId,requestId:'synthetic-queued-at-limit',clarification});
      assert.equal(row.nextInput,clarification);assert.equal(row.queuedRecoveryInput,true);
      assert.deepEqual(tasks.call('get_task',{taskId}).unsentInputs,[{id:attemptId,text:sent[0],possiblyNotDelivered:true}],
        'The uncertain input stays visible when a clarification takes the execution slot');
      for(const view of [continued,tasks.call('get_task',{taskId,brief:true}),tasks.call('list_tasks').tasks[0]]){
        assert.equal(view.unsentInputCount,1);assert.equal(view.possiblyNotDeliveredCount,1);
        assert.equal(Object.hasOwn(view,'unsentInputs'),false);
      }
    }
    if(nextLimit){
      const signalLimit=turnId=>held.cli.emit('notification',{method:'error',params:{threadId:row.chatId,turnId,
        error:{message:'Synthetic usage limit',codexErrorInfo:'usageLimitExceeded'},willRetry:false}});
      signalLimit(held.turnId);
      assert.equal(row.exhaustedTurnId,held.turnId);
      if(automatic){
        signalLimit(firstLimit);
        assert.equal(row.exhaustedTurnId,held.turnId,'A stale limit cannot replace the current turn limit while its ACK is missing');
      }
    }
    await held.cli.stop();
    held.reject(lostAck());await tasks.idle();
    fs.unlinkSync(gate);
    const saved=tasks.store.read('mcp-task',taskId);
    assert.equal(saved.recoveryRequired,false);
    const expected=automatic?[]:[sent[0],clarification];
    assert.deepEqual(recoveryTexts(),expected);
    assert.deepEqual((saved.unsentInputs || []).map(item=>item.text),expected);
    assert.equal(tasks.call('get_task',{taskId}).possiblyNotDeliveredCount,undefined);
    assert((saved.unsentInputs || []).every(item=>!Object.hasOwn(item,'possiblyNotDelivered')),'Exit settles the flag');
    if(nextLimit){
      assert.equal(saved.state,'waiting_limit');
      assert.deepEqual(saved.limitContinuation,{exhaustedTurnId:held.turnId,state:'pending'});
      assert.equal(saved.nextInput,recovery.CONTINUE);
      if(automatic){
        assert.notEqual(held.turnId,firstLimit);
        await poller.tick();await step(tasks);assert.equal(sent.length,2,'The fixed continuation waits for the cooldown');
        now+=60000;await poller.tick();
        await until(host,()=>row.state==='completed');
        assert.deepEqual(sent.slice(1),[recovery.CONTINUE,recovery.CONTINUE],'Only the new limit arms another fixed continuation');
        assert.deepEqual(recoveryTexts(),[]);
      }
    }else{
      assert.equal(saved.state,'error');assert.equal(saved.nextInput,undefined);
      await poller.tick();await step(tasks);
      assert.equal(sent.length,2,'An interrupted automatic send is not replayed without a new limit event');
    }
  }finally{held?.reject(lostAck());poller?.dispose();await host?.dispose({force:true});await data.close();}
}

async function replyWithQueuedInput(sameText){
  const directory=project('reply-with-queued-input-'+sameText),gate=path.join(directory,'synthetic-dispatch-gate');
  const data=fixture(directory,{cliEnv:{RUNDIX_SYNTHETIC_DISPATCH_GATE:gate}});
  let host;
  try{
    host=await createHeadlessHost({root:directory,generation:'synthetic-reply-exit',taskOptions:{scope:()=> 'synthetic-space'},...data.hostOptions});
    const tasks=host.mcp.tasks;tasks.schedule=()=>{};
    const {taskId}=await tasks.call('submit_task',{requestId:'synthetic-reply-task',description:'Synthetic question task',acceptanceCriteria:'Synthetic check',projectDirectory:directory});
    const row=tasks.get(taskId);await until(host,()=>row.state==='completed');
    const question={id:'synthetic-async-question',type:'agentMessage',turnId:row.turnId,questions:[{title:'Synthetic question'}]};
    const answers={0:'Synthetic answer'};
    const clarification=sameText?require('../runtime/async-questions.cjs').buildReply(question,answers):'Synthetic unrelated clarification';
    await tasks.call('continue_task',{taskId,requestId:'synthetic-unrelated',clarification});
    const {core}=host,session=core.sessions.get(row.sessionKey) || core.createSession({key:row.sessionKey,saved:core.store.session(row.sessionKey)});
    session.items.push(question);
    await core.save(session);
    await tasks.observe(row);assert.equal(row.state,'waiting_approval');
    fs.writeFileSync(gate,'ack');
    const questionTurn=row.turnId;
    await tasks.call('continue_task',{taskId,requestId:'synthetic-reply',approval:{id:'async-question:'+question.id,answers}});
    assert.equal(row.deliveryPhase,'confirmed','The unrelated reply used turn/start and received an ACK');
    assert.notEqual(row.turnId,questionTurn);
    assert.equal(row.nextInput,clarification);assert.equal(row.queuedRecoveryInput,true);
    await host.provider.cli.stop();
    const saved=tasks.store.read('mcp-task',taskId);
    assert.equal(saved.state,'error');assert.equal(saved.nextInput,undefined);
    assert.deepEqual(saved.unsentInputs.map(item=>item.text),[clarification],'The exit preserves the queued text independently of the reply ACK');
  }finally{await host?.dispose({force:true});await data.close();}
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

// Live 0.4.2 defect: admission restarted the CLI between thread/start and the
// first turn; the empty thread had no rollout, so its resume failed forever.
async function freshThreadGenerationChange(){
  const directory=project('fresh-thread-generation'),data=fixture(directory);
  let host,reconnected=false,sends=[],leaseFollowed=[];
  const makeCli=data.hostOptions.providerOptions.createCli;
  data.hostOptions.providerOptions.createCli=options=>{
    const cli=makeCli(options),request=cli.request.bind(cli);
    cli.request=async(method,params,...args)=>{
      if(method==='turn/start'){sends.push(params);leaseFollowed.push(host.core.turnLeases.has(params.threadId));}
      const result=await request(method,params,...args);
      if(method==='thread/start' && !reconnected){
        reconnected=true;
        await host.provider.configureByClient({clientId:'synthetic-client',operationId:'synthetic-fresh-reconnect',expectedSelectionRevision:1,action:'synthetic',payload:{scenario:'prepare-reconnect'}});
      }
      return result;
    };return cli;
  };
  try{
    host=await createHeadlessHost({root:directory,generation:'synthetic-fresh-thread',taskOptions:{scope:()=> 'synthetic-space'},...data.hostOptions});
    const submitted=await host.mcp.tasks.call('submit_task',{requestId:'synthetic-fresh',description:'Synthetic fresh',acceptanceCriteria:'Synthetic check',projectDirectory:directory});
    const row=host.mcp.tasks.get(submitted.taskId);
    await until(host,()=>row.state==='completed' || row.state==='error');
    assert.equal(row.state,'completed','A fresh thread lost by a CLI restart before its first turn is replaced, not refused');
    assert(reconnected);assert.equal(sends.length,1,'The original input is sent exactly once');assert.equal(sends[0].threadId,row.chatId);
    // Live 0.4.2 defect: the turn's leases stayed on the replaced thread id and
    // blocked the project directory for every later turn.
    await host.mcp.tasks.call('continue_task',{taskId:row.taskId,requestId:'synthetic-fresh-continue',clarification:'Synthetic second turn'});
    await until(host,()=>row.state==='completed' && sends.length===2);assert.equal(sends[1].threadId,row.chatId);
    assert.deepEqual(leaseFollowed,[true,true],'The in-flight lease is keyed by the replacement before dispatch');
  }finally{await host?.dispose({force:true});await data.close();}
}

// A CLI/service restart leaves the last turn 'inProgress' on an idle thread: it is
// a recoverable interruption in the same chat, never a cancel or a lost task.
async function restartInterruption(){
  const {createTaskStatus}=require('../runtime/service-task-status.cjs');
  const s={id:'synthetic-interrupted',key:'synthetic-interrupted',loaded:false,items:[],prefs:{}};
  const server={request:async method=>method==='thread/resume'?{thread:{status:{type:'idle'}}}:method==='thread/turns/list'?{data:[{id:'synthetic-cut',status:'inProgress'}]}:{data:[]}};
  const core={sessions:new Map([[s.key,s]]),store:{session:()=>s},state:{server},connect:async()=>{},save:async()=>{},resumeOptions:async()=>({})};
  const row=task('synthetic-interrupted',project('interrupted'));row.state='running';row.chatId=s.id;row.deliveryPhase='confirmed';
  const status=createTaskStatus({core,provider:{cli:{binding:{appServerGeneration:'synthetic-new'}}},now:Date.now,runs:new Map(),finishRun(){},
    status:async()=>({done:!s.busy,failed:true,chatId:s.id})});
  const value=await status(row);assert.equal(value.interruptedByRestart,true);assert.equal(s.lastTurnStatus,'restartInterrupted');
  {
    const limited={id:'synthetic-limited',key:'synthetic-limited',loaded:false,items:[],prefs:{}};
    const limitServer={request:async method=>method==='thread/resume'?{thread:{status:{type:'idle'}}}:method==='thread/turns/list'?{data:[{id:'synthetic-limit-turn',status:'failed',error:{codexErrorInfo:'usageLimitExceeded'}}]}:{data:[]}};
    const limitRow=task('synthetic-limited',project('limited'));Object.assign(limitRow,{state:'queued',chatId:limited.id,deliveryPhase:'confirmed'});
    recovery.manualInput(Object.assign(limitRow,{exhaustedTurnId:'synthetic-limit-turn'}));
    const limitStatus=createTaskStatus({core:{...core,sessions:new Map([[limited.key,limited]]),state:{server:limitServer}},provider:{cli:{binding:{appServerGeneration:'synthetic-new'}}},now:Date.now,runs:new Map(),finishRun(){},
      status:async()=>({done:true,failed:true,chatId:limited.id})});
    assert.equal((await limitStatus(limitRow)).exhaustedTurnId,undefined,'A limit answered by client input never re-arms the fixed continuation');
  }
  let sent=[];
  const tasks=harness('restart-interruption',true,{status,start:async(_task,input)=>{sent.push(input);}});
  try{
    tasks.tasks.set(row.taskId,row);tasks.save(row);await tasks.observe(row);
    assert.equal(row.state,'error');assert.equal(row.recoveryRequired,false);assert.match(row.error,/Continue to resume/);
    tasks.call('continue_task',{taskId:row.taskId,requestId:'synthetic-resume-interrupted',clarification:'Synthetic resume'});
    await step(tasks);assert.deepEqual(sent,['Synthetic resume'],'Continue resumes the same task chat');
  }finally{tasks.dispose();}
}

// After a service restart a never-turned thread has no rollout: its unsent input is
// requeued for a fresh thread instead of retrying an impossible resume forever.
async function lostEmptyThread(){
  const {createTaskStatus}=require('../runtime/service-task-status.cjs');
  for(const ran of [false,true]){
    const s={id:'synthetic-empty',key:'synthetic-empty-'+ran,loaded:false,items:[],prefs:{},...(ran?{lastStartedTurnId:'synthetic-ran'}:{})};
    const server={request:async method=>{if(method==='thread/resume')throw Object.assign(Error('Synthetic no rollout found for thread'),{code:-32600});return {data:[]};}};
    const core={sessions:new Map([[s.key,s]]),store:{session:()=>s},state:{server},connect:async()=>{},save:async()=>{},resumeOptions:async()=>({})};
    const row=task(s.key,project('empty-'+ran));Object.assign(row,{state:'running',chatId:s.id,deliveryPhase:'dispatching',nextInput:'Synthetic first input',queuedRecoveryInput:true});
    const status=createTaskStatus({core,provider:{cli:{binding:{appServerGeneration:'synthetic-new'}}},now:Date.now,runs:new Map(),finishRun(){},status:async()=>{throw Error('Must not read');}});
    if(ran){await assert.rejects(status(row),/no rollout/);assert.equal(s.id,'synthetic-empty','A thread that ran is never replaced');continue;}
    {
      const cancelled={...s,key:'synthetic-empty-cancel'},cancelRow={...row,cancelRequested:true};
      const statusCancel=createTaskStatus({core:{...core,sessions:new Map([[cancelRow.sessionKey,cancelled]])},provider:{cli:{binding:{appServerGeneration:'synthetic-new'}}},now:Date.now,runs:new Map(),finishRun(){},status:async()=>{throw Error('Must not read');}});
      assert.equal((await statusCancel(cancelRow)).cancelled,true,'A cancel of a lost empty thread ends cancelled');
    }
    const tasks=harness('lost-empty',true,{status});
    try{
      inputRecovery.begin(row,{id:'synthetic-empty-attempt',text:row.nextInput,threadId:s.id});
      inputRecovery.expose(row,'synthetic-empty-attempt');
      tasks.tasks.set(row.taskId,row);tasks.save(row);await tasks.observe(row);
      assert.equal(row.state,'queued');assert.equal(row.nextInput,'Synthetic first input');assert.equal(row.deliveryPhase,'preparing');
      assert.deepEqual(tasks.call('get_task',{taskId:row.taskId}).unsentInputs,[],'Missing-rollout requeue keeps text only in the queue');
      assert.equal(s.id,null);assert.equal(row.chatId,null,'The next send starts a fresh thread');
    }finally{tasks.dispose();}
  }
}

// End to end: the first turn was refused after thread/start, then the service
// restarted. The MCP start path must replace the empty thread, not refuse forever.
async function emptyThreadServiceRestart(){
  const directory=project('empty-thread-restart'),data=fixture(directory);
  let host,refuse=true,sends=[];
  const makeCli=data.hostOptions.providerOptions.createCli;
  data.hostOptions.providerOptions.createCli=options=>{
    const cli=makeCli(options),request=cli.request.bind(cli);
    cli.request=async(method,params,...args)=>{
      if(method==='turn/start'){
        if(refuse)throw Object.assign(Error('Synthetic refused first turn'),{deliveryUncertain:false});
        sends.push(params);
      }
      return request(method,params,...args);
    };return cli;
  };
  const options={root:directory,taskOptions:{scope:()=> 'synthetic-space'},...data.hostOptions};
  try{
    host=await createHeadlessHost({...options,generation:'synthetic-empty-before'});
    const submitted=await host.mcp.tasks.call('submit_task',{requestId:'synthetic-empty-restart',description:'Synthetic empty',acceptanceCriteria:'Synthetic check',projectDirectory:directory});
    let row=host.mcp.tasks.get(submitted.taskId);
    await until(host,()=>!!host.core.sessions.get(row.sessionKey)?.id && !host.mcp.tasks.starting.size && row.state!=='running');
    const emptyThread=host.core.sessions.get(row.sessionKey).id;
    await host.dispose({force:true});host=null;await data.close();refuse=false;
    host=await createHeadlessHost({...options,generation:'synthetic-empty-after'});
    row=host.mcp.tasks.get(submitted.taskId);
    if(row.state==='error')await host.mcp.tasks.call('continue_task',{taskId:row.taskId,requestId:'synthetic-empty-continue',clarification:'Synthetic empty retry'});
    else {row.blockedUntil=0;row.state='queued';host.mcp.tasks.save(row);}
    await until(host,()=>row.state==='completed' || row.state==='error' && !host.mcp.tasks.starting.size && sends.length>0);
    assert.equal(row.state,'completed','An empty thread lost to a service restart is replaced on the MCP start path');
    assert.equal(sends.length,1);assert.notEqual(sends[0].threadId,emptyThread);assert.equal(row.chatId,sends[0].threadId);
  }finally{await host?.dispose({force:true});await data.close();}
}

async function dispatchRestart(phase){
  const directory=project('dispatch-restart-'+phase),gate=path.join(directory,'synthetic-dispatch-gate');
  const beforeWrite=phase==='before-write',beforeAck=phase==='before-ack';
  fs.writeFileSync(gate,beforeAck?'deliver':'ack');
  const data=fixture(directory,{cliEnv:{RUNDIX_SYNTHETIC_DISPATCH_GATE:gate}});
  const makeCli=data.hostOptions.providerOptions.createCli;
  let host,checkpoint,sessionCheckpoint,oldTaskId,intercept=true,accepted=false,ackSave=false,sends=0,release;
  data.hostOptions.providerOptions.createCli=options=>{
    const cli=makeCli(options),request=cli.request.bind(cli),emit=cli.emit.bind(cli);
    cli.emit=(event,message,...args)=>{
      if(intercept && beforeAck && event==='notification' && message.params?.item?.type==='userMessage'){
        accepted=true;return false; // The rollout has the item. The old service never sees it.
      }
      return emit(event,message,...args);
    };
    cli.request=(method,params,...args)=>{
      if(method!=='turn/start')return request(method,params,...args);
      if(intercept && !checkpoint){
        oldTaskId=host.mcp.tasks.tasks.values().next().value.taskId;
        const task=host.mcp.tasks.get(oldTaskId);
        checkpoint=host.mcp.tasks.store.read('mcp-task',oldTaskId);
        sessionCheckpoint=host.core.store.session(task.sessionKey);
        assert.equal(checkpoint.deliveryPhase,'dispatching');
        assert.equal(checkpoint.unsentInputs[0].possiblyNotDelivered,true);
        assert.deepEqual(host.mcp.tasks.call('get_task',{taskId:oldTaskId}).unsentInputs,[]);
        if(beforeWrite)return new Promise((_,reject)=>{release=()=>reject(Error('Synthetic process ended before write'));});
      }
      sends++;return request(method,params,...args);
    };
    return cli;
  };
  const create=generation=>createHeadlessHost({root:directory,generation,taskOptions:{scope:()=> 'synthetic-space'},...data.hostOptions});
  try{
    host=await create('synthetic-before-crash');
    let tasks=host.mcp.tasks;tasks.pause();
    await tasks.call('submit_task',{requestId:'synthetic-crash-submit',description:'Synthetic crash input',acceptanceCriteria:'Synthetic check',projectDirectory:directory});
    const store=tasks.store,sessionStore=host.core.store,write=store.write.bind(store);
    if(!beforeWrite && !beforeAck)store.write=(kind,id,value)=>{
      if(intercept && kind==='mcp-task' && value.deliveryPhase==='confirmed'){
        ackSave=true;throw Error('Synthetic process ended after ACK before the task write');
      }
      return write(kind,id,value);
    };
    tasks.resume();
    await until(host,()=>beforeWrite?!!release:beforeAck?accepted:ackSave,false);
    assert.equal(sends,beforeWrite?0:1);
    assert.equal(store.read('mcp-task',oldTaskId).deliveryPhase,'dispatching');
    // Restore only the files available at the crash boundary after disposing the fixture's processes.
    tasks.pause();await host.dispose({force:true});release?.();await data.close();
    store.write=write;write('mcp-task',oldTaskId,checkpoint);sessionStore.write('session',checkpoint.sessionKey,sessionCheckpoint);
    intercept=false;fs.unlinkSync(gate);
    host=await create('synthetic-after-crash');
    tasks=host.mcp.tasks;tasks.pause();
    const restored=tasks.get(oldTaskId),get=()=>tasks.call('get_task',{taskId:oldTaskId});
    assert.deepEqual(get().unsentInputs,[{id:checkpoint.inputAttempt.id,text:checkpoint.nextInput,possiblyNotDelivered:true}]);
    await tasks.observe(restored);
    if(beforeWrite){
      assert.equal(restored.state,'queued','Missing rollout preserves the existing re-queue');
      assert.equal(restored.nextInput,checkpoint.nextInput);
      assert.equal(get().unsentInputCount,0,'Re-queued input leaves recovery');
      inputRecovery.remember(restored,checkpoint.nextInput);
      tasks.save(restored);
      tasks.resume();await until(host,()=>restored.state==='completed');
      assert.equal(sends,1);
      assert.deepEqual(get().unsentInputs,[],'ACK clears the older plain entry with equal text');
    }else if(beforeAck){
      assert.equal(get().unsentInputCount,0,'A matching item from the recovered rollout proves delivery');
      assert.equal(restored.nextInput,undefined,'Confirmed rollout delivery clears the dispatched text slot');
      assert.equal(restored.deliveryPhase,'confirmed');
      assert.equal(sends,1);
    }else{
      assert.equal(get().possiblyNotDeliveredCount,1,'An ACK lost with the process and no chat item cannot prove delivery');
      assert.equal(sends,1);
    }
  }finally{release?.();await host?.dispose({force:true});await data.close();}
}

async function lateAck(afterRestore=false){
  const directory=project('late-input-ack-'+afterRestore),gate=path.join(directory,'synthetic-dispatch-gate');
  fs.writeFileSync(gate,'late');
  const data=fixture(directory,{cliEnv:{RUNDIX_SYNTHETIC_DISPATCH_GATE:gate}}),makeCli=data.hostOptions.providerOptions.createCli;
  let host,sends=0;
  data.hostOptions.providerOptions.createCli=options=>{
    const cli=makeCli(options),request=cli.request.bind(cli);
    cli.request=(method,params,timeout,late)=>{
      if(method==='turn/start'){sends++;timeout=100;}
      return request(method,params,timeout,late);
    };
    return cli;
  };
  try{
    host=await createHeadlessHost({root:directory,generation:'synthetic-late-ack',...data.hostOptions,taskOptions:{scope:()=> 'synthetic-space'}});
    const tasks=host.mcp.tasks;
    const {taskId}=await tasks.call('submit_task',{requestId:'synthetic-late-ack',description:'Synthetic late ACK',acceptanceCriteria:'Synthetic check',projectDirectory:directory});
    const get=()=>tasks.call('get_task',{taskId});
    await until(host,()=>get().possiblyNotDeliveredCount===1,false);
    const id=get().unsentInputs[0].id;
    if(afterRestore){
      await tasks.idle();tasks.pause();
      const completed=tasks.get(taskId);
      // Simulate terminal status without a readable user item, so only the pending ACK can prove delivery.
      completed.state='error';completed.recoveryRequired=false;delete completed.nextInput;tasks.save(completed);
      const expected=tasks.clearFinished(completed.space,{dryRun:true});
      assert.equal(expected.archived,1);
      tasks.clearFinished(completed.space,{expected});
      assert(!tasks.tasks.has(taskId));
      tasks.call('continue_task',{taskId,requestId:'synthetic-after-archive',clarification:'Synthetic restored continuation'});
    }
    fs.writeFileSync(gate,'release-late-ack');
    await until(host,()=>!tasks.store.read('mcp-task',taskId).unsentInputs.some(row=>row.id===id),false);
    const persisted=tasks.store.read('mcp-task',taskId);
    assert(!persisted.unsentInputs.some(row=>row.id===id));
    if(afterRestore){
      assert.equal(persisted.state,'queued');
      assert.equal(persisted.nextInput,'Synthetic restored continuation');
      assert(persisted.operations.some(op=>op.requestId==='synthetic-after-archive'));
    }
    assert.equal(get().unsentInputCount,0);
    assert.equal(sends,1,'A late ACK settles recovery without replaying the turn');
  }finally{await host?.dispose({force:true});await data.close();}
}

async function attemptAttribution(){
  const tasks=harness('attempt-attribution',true,{});
  try{
    const row=task('synthetic-attribution',project('attempt-attribution')),text='Synthetic identical input';
    const session={id:'synthetic-thread',loaded:true,cliGeneration:'synthetic-cli',items:[]};
    const oldItem={id:'synthetic-old-item',type:'userMessage',turnId:'synthetic-old-turn',content:[{type:'text',text}]};
    const newItem={...oldItem,id:'synthetic-new-item',turnId:'synthetic-new-turn'};
    let latest=oldItem.turnId,items=[oldItem];
    const server={request:async method=>method==='thread/read'?{thread:{status:{type:'idle'}}}:
      method==='thread/turns/list'?{data:[{id:latest,status:'completed'}]}:{data:items}};
    const core={sessions:new Map([[row.sessionKey,session]]),state:{server},connect:async()=>{},save:async()=>{}};
    tasks.adapter.status=require('../runtime/service-task-status.cjs').createTaskStatus({
      core,provider:{cli:{binding:{appServerGeneration:session.cliGeneration}}},runs:new Map(),
      status:async()=>({done:true,failed:true,chatId:session.id})
    });
    tasks.tasks.set(row.taskId,row);
    Object.assign(row,{chatId:session.id,deliveryPhase:'dispatching',baselineItems:[]});
    const begin=(id,previousTurnId)=>{
      inputRecovery.begin(row,{id,text,threadId:session.id,previousTurnId});
      inputRecovery.expose(row,id);
    };
    begin('synthetic-attempt-first',oldItem.turnId);
    const get=()=>tasks.call('get_task',{taskId:row.taskId});
    const observe=async()=>{row.needsReconcile=true;await tasks.observe(row);};
    await observe();
    assert.equal(get().possiblyNotDeliveredCount,1,'A matching message in the previous turn is not proof');
    begin('synthetic-attempt-second',oldItem.turnId);
    assert.equal(get().possiblyNotDeliveredCount,2,'Equal text has two independent attempt IDs');
    latest=newItem.turnId;items=[];
    await observe();
    assert.equal(get().possiblyNotDeliveredCount,2,'A bounded read without the item does not settle delivery');
    items=[newItem];
    await observe();
    assert.deepEqual(get().unsentInputs,[{id:'synthetic-attempt-first',text,possiblyNotDelivered:true}]);
    const panel=require('../runtime/mcp-panel.cjs').snapshot({records:[row],pending:()=>[]}).tasks[0];
    assert.equal(panel.possiblyNotDeliveredCount,1);
    assert.equal(panel.unsentInputs[0].possiblyNotDelivered,true);
    begin('synthetic-attempt-protected',newItem.turnId);
    for(let index=0;index<55;index++)inputRecovery.remember(row,'Synthetic queue '+index+' '.repeat(90000));
    assert.equal(get().possiblyNotDeliveredCount,1,'The current uncertain entry survives count and byte pruning');
    assert(row.unsentInputs.some(item=>item.id==='synthetic-attempt-protected'));
    assert(Buffer.byteLength(JSON.stringify(row.unsentInputs))<=inputRecovery.MAX_BYTES);
  }finally{tasks.dispose();}
}

async function definiteDispatchRefusal(retryable){
  const directory=project('definite-dispatch-refusal-'+retryable),data=fixture(directory);
  const makeCli=data.hostOptions.providerOptions.createCli;
  let host,attempt,sends=0;
  data.hostOptions.providerOptions.createCli=options=>{
    const cli=makeCli(options),request=cli.request.bind(cli);
    cli.request=async(method,params,...args)=>{
      if(method==='turn/start'){
        if(!attempt){
          const tasks=host.mcp.tasks,row=tasks.tasks.values().next().value;
          [attempt]=tasks.store.read('mcp-task',row.taskId).unsentInputs;
          throw Object.assign(Error('Synthetic definite send refusal'),{deliveryUncertain:false,notSent:true,retryable});
        }
        sends++;
      }
      return request(method,params,...args);
    };
    return cli;
  };
  try{
    host=await createHeadlessHost({root:directory,generation:'synthetic-definite-refusal',...data.hostOptions,taskOptions:{scope:()=> 'synthetic-space'}});
    const tasks=host.mcp.tasks;tasks.schedule=()=>{};
    const {taskId}=await tasks.call('submit_task',{requestId:'synthetic-refused-input',description:'Synthetic refused input',acceptanceCriteria:'Synthetic check',projectDirectory:directory});
    await step(tasks);
    const row=tasks.get(taskId),get=()=>tasks.call('get_task',{taskId});
    assert.equal(sends,0);
    assert.equal(get().possiblyNotDeliveredCount,undefined);
    if(retryable){
      assert.equal(row.state,'queued');
      assert.equal(row.nextInput,attempt.text);
      assert.deepEqual(get().unsentInputs,[],'A definite refusal returned to the queue drops the attempt entry');
      row.blockedUntil=0;await until(host,()=>row.state==='completed');
      assert.equal(sends,1);
    }else{
      assert.equal(row.state,'error');
      assert.deepEqual(get().unsentInputs,[{id:attempt.id,text:attempt.text}],'A terminal refusal converts the same entry to ordinary unsent');
      assert.equal(row.nextInput,undefined);
      await Promise.all(tasks.cleanup);
      const estimate=tasks.clearFinished(row.space,{dryRun:true});
      assert.deepEqual(estimate,{archived:1,skipped:0,withUnsent:1},'A settled refusal is eligible for manual archival');
      assert.deepEqual(tasks.clearFinished(row.space,{expected:estimate}),estimate);
      assert(!tasks.tasks.has(taskId));
      assert.deepEqual(get().unsentInputs,[{id:attempt.id,text:attempt.text}]);
    }
  }finally{await host?.dispose({force:true});await data.close();}
}

function settledInput(){
  const text='Synthetic repeated input',row={nextInput:text,queuedRecoveryInput:false};
  const plainId=inputRecovery.remember(row,text);
  const begin=id=>inputRecovery.begin(row,{id,text,threadId:'synthetic-input-thread'});
  begin('synthetic-refused');inputRecovery.settle(row,'synthetic-refused',true);
  assert.deepEqual(row.unsentInputs,[{id:plainId,text}],'A refusal deduplicates plain text');
  assert.equal(row.nextInput,undefined,'Settlement clears the current dispatched text');
  row.nextInput=text;begin('synthetic-older');inputRecovery.expose(row,'synthetic-older');
  begin('synthetic-current');inputRecovery.expose(row,'synthetic-current');
  inputRecovery.confirm(row,'synthetic-older');
  assert.equal(row.nextInput,text,'Older proof cannot clear the newer dispatch slot with equal text');
  assert.deepEqual(inputRecovery.page(row).unsentInputs,[{id:'synthetic-current',text,possiblyNotDelivered:true}]);
}

async function resendPlainInput(){
  const directory=project('explicit-plain-resend'),data=fixture(directory),makeCli=data.hostOptions.providerOptions.createCli;
  const text='Synthetic explicit repeat';let host,refused=false,sends=0;
  data.hostOptions.providerOptions.createCli=options=>{
    const cli=makeCli(options),request=cli.request.bind(cli);
    cli.request=async(method,params,...args)=>{
      if(method==='turn/start' && params.input[0].text===text){
        if(!refused){refused=true;throw Object.assign(Error('Synthetic refusal'),{notSent:true,retryable:false,deliveryUncertain:false});}
        sends++;
      }
      return request(method,params,...args);
    };
    return cli;
  };
  try{
    host=await createHeadlessHost({root:directory,generation:'synthetic-repeat',...data.hostOptions});
    const tasks=host.mcp.tasks;tasks.schedule=()=>{};
    const {taskId}=await tasks.call('submit_task',{requestId:'synthetic-submit-repeat',description:'Synthetic task',acceptanceCriteria:'Synthetic check',projectDirectory:directory});
    const row=tasks.get(taskId),get=()=>tasks.call('get_task',{taskId});
    const send=requestId=>tasks.call('continue_task',{taskId,requestId,clarification:text});
    await until(host,()=>row.state==='completed');
    send('synthetic-refused-repeat');await step(tasks);
    assert.equal(row.state,'error');assert.deepEqual(get().unsentInputs.map(entry=>entry.text),[text]);
    inputRecovery.begin(row,{id:'synthetic-other-attempt',text,threadId:row.chatId,previousTurnId:row.turnId});
    inputRecovery.expose(row,'synthetic-other-attempt');tasks.save(row);
    send('synthetic-accepted-repeat');await until(host,()=>row.state==='completed');
    assert.equal(sends,1);
    assert.deepEqual(get().unsentInputs,[{id:'synthetic-other-attempt',text,possiblyNotDelivered:true}],
      'ACK clears plain unsent text and preserves another attempt’s flagged row');
    inputRecovery.settle(row,'synthetic-other-attempt',true);tasks.save(row);
    send('synthetic-accepted-plain');await until(host,()=>row.state==='completed');
    assert.equal(sends,2);assert.deepEqual(get().unsentInputs,[],'ACK of an explicit resend clears the sole plain entry');
  }finally{await host?.dispose({force:true});await data.close();}
}

(async()=>{try{
  await emptyThreadServiceRestart();await restartInterruption();await lostEmptyThread();await queuedInput();await windowsAndSlowRecovery();await lightweightStatus();await repeatedLimit();await historyRecovery();await preparingRestart();await generationAndPredispatchExit(false);await generationAndPredispatchExit(true);await freshThreadGenerationChange();
  await exitDuringLimit('clarification-at-limit');await exitDuringLimit('automatic-exit-without-limit');await exitDuringLimit('automatic-exit-with-new-limit');await replyWithQueuedInput(false);await replyWithQueuedInput(true);
  for(const phase of ['before-write','before-ack','after-ack'])await dispatchRestart(phase);
  await lateAck();await lateAck(true);await attemptAttribution();await definiteDispatchRefusal(true);await definiteDispatchRefusal(false);settledInput();await resendPlainInput();
  console.log('PASS review regressions: window recovery, restart and reconnect, retry slots, bounded status/limits/history, dispatch checkpoints, late ACK after restore, refusal archival, missing-rollout requeue, plain resend dedup and attempt isolation.');
}finally{assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-review-regression-synthetic-'));fs.rmSync(root,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
