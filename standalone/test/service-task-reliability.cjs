require('./test-isolation.cjs').isolate();
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHeadlessHost}=require('../runtime/service-headless-host.cjs');
const {createLimitPoller}=require('../runtime/service-limit-poller.cjs');
const {fixture}=require('./service-fixture.cjs');
const {CONTINUE,MAX_READ_FAILURES}=require('../runtime/task-recovery.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(host,check){
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){await host.mcp.tasks.tick();await host.mcp.tasks.idle();if(check())return;await pause(20);}
  throw Error('Synthetic reliability deadline: '+JSON.stringify([...host.mcp.tasks.tasks.values()].map(t=>({state:t.state,progress:t.progress,error:t.error,limit:t.limitContinuation,turn:t.turnId,wait:t.waitingLimit}))));
}
async function scenario(kind){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-task-reliability-synthetic-'));
  const cliEnv=kind==='limit'?{RUNDIX_SYNTHETIC_LIMIT_ONCE:'1'}:kind==='restart'?{RUNDIX_SYNTHETIC_HOLD:'1'}:{};
  const data=fixture(root,{cliEnv}),sends=[];let host,poller;
  const makeCli=data.hostOptions.providerOptions.createCli;
  data.hostOptions.providerOptions.createCli=options=>{
    const cli=makeCli(options),request=cli.request.bind(cli);
    if(kind==='lost-terminal') {
      const emit=cli.emit.bind(cli);let dropped=false;
      cli.emit=(event,message,...args)=>{
        if(event==='notification' && message.method==='turn/completed' && !dropped){dropped=true;return false;}
        return emit(event,message,...args);
      };
    }
    cli.request=async(method,params,...args)=>{
      if(method==='turn/start')sends.push({threadId:params.threadId,input:params.input});
      const result=await request(method,params,...args);
      if(kind==='lost-terminal' && method==='turn/start' && sends.length===1)throw Object.assign(Error('Synthetic lost start ACK'),{deliveryUncertain:true});
      return result;
    };
    return cli;
  };
  const submit=id=>host.mcp.tasks.call('submit_task',{requestId:id,description:'Synthetic original task',acceptanceCriteria:'Synthetic check',projectDirectory:root});
  try{
    host=await createHeadlessHost({root,generation:'synthetic-'+kind,taskOptions:{scope:()=> 'synthetic-space'},...data.hostOptions});
    if(kind==='chatless'){
      const submitted=await submit('synthetic-no-chat'),task=host.mcp.tasks.get(submitted.taskId);
      task.state='running';task.recoveryRequired=true;task.needsReconcile=true;task.cancelRequested=true;task.progress='Cancellation requested';host.mcp.tasks.save(task);
      await host.mcp.tasks.tick();assert.equal(task.state,'cancelled');assert.equal(task.recoveryRequired,false);
      const revision=task.revision;for(let n=0;n<30;n++)await host.mcp.tasks.tick();
      assert.equal(task.revision,revision);assert.equal(data.children.length,0,'No chat/no dispatched model turn needs no CLI read');
      await host.mcp.tasks.call('continue_task',{taskId:task.taskId,requestId:'synthetic-retry-no-chat',clarification:'Synthetic retry'});
      await until(host,()=>task.state==='completed');assert.equal(sends.length,1);return;
    }
    const submitted=await submit('synthetic-'+kind);let task=host.mcp.tasks.get(submitted.taskId);
    task.createdAt=Date.now()-600000;
    if(kind==='lost-terminal') {
      await until(host,()=>{task.lastStatusReadAt=0;return task.state==='completed';});
      assert.equal(sends.length,1);assert.equal(host.provider.activeTurns,0,'Authoritative terminal read releases the uncertain grant without an ACK/completion notification');
      assert.equal(task.recoveryRequired,false);return;
    }
    if(kind==='restart'){
      await until(host,()=>task.state==='running' && !!task.turnId);
      const chatId=task.chatId,record=JSON.parse(JSON.stringify(task)),store=host.mcp.tasks.store;
      // Restore exactly the synthetic crash checkpoint after stopping the test
      // child. The owner service and its records are never involved.
      await host.dispose({force:true});host=null;await data.close();
      store.write('mcp-task',record.taskId,record);cliEnv.RUNDIX_SYNTHETIC_HOLD='0';
      host=await createHeadlessHost({root,generation:'synthetic-restarted',taskOptions:{scope:()=> 'synthetic-space'},...data.hostOptions});
      task=host.mcp.tasks.get(record.taskId);
      await until(host,()=>['cancelled','error','completed'].includes(task.state) && !task.recoveryRequired);
      assert.equal(task.chatId,chatId);assert.equal(sends.length,1,'Restart reconciles the saved rollout without replaying the original');
      await host.mcp.tasks.call('continue_task',{taskId:task.taskId,requestId:'synthetic-restart-continue',clarification:'Synthetic recovery after restart'});
      await until(host,()=>task.state==='completed');assert.equal(task.chatId,chatId);assert.equal(sends.length,2);return;
    }
    if(kind==='limit'){
      await until(host,()=>task.state==='waiting_limit');
      const chatId=task.chatId;assert(chatId);assert.equal(task.limitContinuation.state,'pending');assert.equal(task.nextInput,CONTINUE);
      let now=Date.now(),available=false;const resetAt=now+3600000,prepare=host.provider.prepareTurn.bind(host.provider);
      host.provider.prepareTurn=async(task,options)=>available?prepare(task,options):{kind:'waitUntil',waitId:task.waitId,resetAt,reason:'exhausted'};
      poller=createLimitPoller({host,now:()=>now,pollMs:1000000});
      await poller.tick();assert.equal(task.waitingLimit.resetAt,resetAt);assert.equal(host.provider.activeTurns,0);
      await host.mcp.tasks.call('continue_task',{taskId:task.taskId,requestId:'synthetic-limit-fifo',clarification:'Synthetic clarification after continuation'});
      available=true;now=resetAt;await poller.tick();
      await until(host,()=>task.state==='completed');
      assert.equal(task.chatId,chatId);assert.equal(sends.length,3);
      assert.deepEqual(sends.map(send=>send.threadId),[chatId,chatId,chatId]);
      const text=send=>send.input.filter(item=>item.type==='text').map(item=>item.text).join('\n');
      assert.equal(text(sends[1]),CONTINUE);assert.equal(text(sends[2]),'Synthetic clarification after continuation');
      assert.equal(task.limitContinuation.state,'delivered');assert.equal(host.provider.activeTurns,0);
      return;
    }
    await until(host,()=>task.state==='completed');const chatId=task.chatId;
    // Reproduce a restart record whose task chat ID lagged the durable session.
    task.chatId=null;task.state='running';task.recoveryRequired=true;task.needsReconcile=true;
    host.mcp.tasks.save(task);await host.mcp.tasks.tick();assert.equal(task.chatId,chatId);assert.equal(task.state,'completed');
    const adapter=host.mcp.tasks.adapter,status=adapter.status;let reads=0,unavailable=true;
    adapter.status=async value=>{reads++;if(unavailable)throw Error('Synthetic status unavailable');return status(value);};
    task.state='running';task.recoveryRequired=true;host.mcp.tasks.save(task);
    for(let n=0;n<MAX_READ_FAILURES;n++){
      if(task.statusRead)task.statusRead.nextAt=0;
      await host.mcp.tasks.tick();const before=reads,revision=task.revision;
      for(let retry=0;retry<20;retry++)await host.mcp.tasks.tick();
      assert.equal(reads,before,'Repeated scheduler ticks respect exponential backoff');assert.equal(task.revision,revision);
    }
    assert.equal(reads,MAX_READ_FAILURES);assert(task.statusRead.paused);
    task.statusRead.nextAt=0;await host.mcp.tasks.tick();assert.equal(reads,MAX_READ_FAILURES,'Status reads stop after the bounded retry budget');
    unavailable=false;
    await host.mcp.tasks.call('continue_task',{taskId:task.taskId,requestId:'synthetic-explicit-recover',clarification:'Synthetic explicit recovery'});
    await until(host,()=>task.state==='completed');assert.equal(task.chatId,chatId);assert.equal(sends.length,2);
    const {history}=require('../runtime/service-task-chat.cjs');
    const cli=host.provider.cli,request=cli.request.bind(cli);let historyCalls=0,historyUnavailable=true,historyNow=Date.now();
    cli.request=(method,...args)=>{
      if(method==='thread/items/list' && historyUnavailable){historyCalls++;throw Error('Synthetic history unavailable');}
      return request(method,...args);
    };
    const readHistory=()=>history({core:host.core,tasks:host.mcp.tasks,task,cursor:'@latest',now:()=>historyNow});
    for(let n=0;n<MAX_READ_FAILURES;n++){
      await assert.rejects(readHistory());const calls=historyCalls;
      await assert.rejects(readHistory(),{code:'connection_unavailable'});assert.equal(historyCalls,calls);
      historyNow+=60000;
    }
    await assert.rejects(readHistory(),{code:'connection_unavailable'});assert.equal(historyCalls,MAX_READ_FAILURES);
    historyUnavailable=false;
    await host.mcp.tasks.call('continue_task',{taskId:task.taskId,requestId:'synthetic-history-recover',clarification:'Synthetic history recovery'});
    await until(host,()=>task.state==='completed');assert.equal(task.chatId,chatId);
    assert(Array.isArray((await readHistory()).items),'Explicit Continue resets history observation as well');
  }finally{
    poller?.dispose();await host?.dispose({force:true});await data.close();
    assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-task-reliability-synthetic-'));fs.rmSync(root,{recursive:true,force:true});
  }
}
Promise.resolve().then(()=>scenario('chatless')).then(()=>scenario('limit')).then(()=>scenario('reads')).then(()=>scenario('restart')).then(()=>scenario('lost-terminal'))
  .then(()=>console.log('PASS task reliability: typed mid-turn limit, one fixed same-thread continuation then FIFO, durable wait/reset, chatless recovery, saved chat reconciliation, bounded status backoff and explicit Continue.'))
  .catch(error=>{console.error(error);process.exitCode=1;});
