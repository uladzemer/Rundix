require('./test-isolation.cjs').isolate();
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHeadlessHost}=require('../runtime/service-headless-host.cjs');
const {fixture}=require('./service-fixture.cjs');
async function scenario(parallel, transient=false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-cold-synthetic-'));
  const data=fixture(root,{cliEnv:{RUNDIX_SYNTHETIC_COLD_ACCOUNT_UPDATE:'1'}});let host;
  try {
    fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({mcpMaxParallelTasks:3}));
    host=await createHeadlessHost({root,generation:'synthetic-cold',...data.hostOptions});
    let attempts=0;
    if(transient){
      const start=host.provider.start.bind(host.provider);
      host.provider.start=async()=>{if(++attempts===1)throw Object.assign(Error('Synthetic cold bootstrap timeout'),{code:'PROVIDER_UNAVAILABLE',reason:'action_required'});return start();};
    }
    const tasks=await Promise.all(Array.from({length:parallel},async(_,i)=>{
      const project=path.join(root,'synthetic-project-'+i);fs.mkdirSync(project);
      return host.mcp.tasks.call('submit_task',{requestId:'synthetic-cold-'+i,description:'Synthetic cold task',acceptanceCriteria:'Synthetic success',projectDirectory:project});
    }));
    if(transient){
      await host.mcp.tasks.tick();await host.mcp.tasks.idle();
      assert.equal(host.mcp.tasks.get(tasks[0].taskId).state,'queued','Definite cold bootstrap timeout stays queued');
    }
    for(const task of tasks){
      const done=await host.mcp.tasks.call('wait_task',{taskId:task.taskId,waitSeconds:10});
      assert.equal(done.state,'completed','Login notification must not poison the initial catalog read');
      assert.equal(done.report.result,'Synthetic success');
    }
    assert.equal(data.children.length,2,'Racing tasks share one provider and one ephemeral CLI');
    if(transient)assert.equal(attempts,2,'Only a definite pre-dispatch bootstrap is retried');
  }finally{await host?.dispose({force:true});await data.close();fs.rmSync(root,{recursive:true,force:true});}
}
async function boundedFailure(code,{recover=false,expire=false,hang=false}={}){
  const {MAX_ATTEMPTS,BUDGET_MS,progress}=require('../runtime/service-readiness.cjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-budget-synthetic-'));
  const data=fixture(root);let host,release;
  try{
    host=await createHeadlessHost({root,generation:'synthetic-budget',...data.hostOptions});
    const tasks=host.mcp.tasks;clearTimeout(tasks.scheduled);tasks.scheduled=null;tasks.schedule=()=>{};
    let attempts=0;
    const start=host.provider.start.bind(host.provider);
    host.provider.start=async()=>{
      attempts++;
      if(hang)return new Promise(resolve=>{release=resolve;});
      if(recover && attempts>1)return start();
      throw Object.assign(Error('Synthetic bootstrap refusal'),{code,reason:'action_required'});
    };
    const project=path.join(root,'synthetic-project');fs.mkdirSync(project);
    const submitted=await tasks.call('submit_task',{requestId:'synthetic-budget',description:'Synthetic task',acceptanceCriteria:'Synthetic success',projectDirectory:project});
    const task=tasks.tasks.get(submitted.taskId);
    if(expire || hang)task.createdAt=Date.now()-BUDGET_MS+(hang?80:-1);
    for(let i=0;i<MAX_ATTEMPTS;i++){
      task.blockedUntil=0;await tasks.tick();await tasks.idle();
      if(task.state==='error')break;
      if(recover && attempts===2){
        const deadline=Date.now()+10000;
        while(task.state==='running' && Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));await tasks.tick();}
        assert.equal(task.state,'completed');break;
      }
      assert.equal(task.state,'queued');assert.equal(task.progress,progress);
      assert.equal(task.serviceReadiness.attempts,i+1,'Retry count is durable in the task checkpoint');
    }
    if(recover){assert.equal(attempts,2);assert.equal(task.serviceReadiness,undefined);}
    else{
      assert.equal(task.state,'error');assert.match(task.error,/action_required/);
      assert.equal(task.recoveryRequired,false);assert.equal(task.needsReconcile,false);
      assert(task.unsentInputs?.length || task.unsentInput,'Unsent input remains recoverable');
      assert.equal(attempts,expire?0:hang?1:MAX_ATTEMPTS);
      release?.();await new Promise(resolve=>setImmediate(resolve));
      assert.equal(data.children.length,0,'An expired bootstrap never continues into model dispatch');
      task.blockedUntil=0;await tasks.tick();await tasks.idle();
      assert.equal(task.state,'error','Terminal tasks do not restart automatically');
    }
  }finally{release?.();await host?.dispose({force:true});await data.close();fs.rmSync(root,{recursive:true,force:true});}
}
async function cancelAfterDeadline(){
  const {BUDGET_MS}=require('../runtime/service-readiness.cjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-cancel-budget-synthetic-'));
  const data=fixture(root,{cliEnv:{RUNDIX_SYNTHETIC_HOLD:'1'}});let host;
  try{
    host=await createHeadlessHost({root,generation:'synthetic-cancel-budget',...data.hostOptions});
    await host.core.connect();
    const tasks=host.mcp.tasks;clearTimeout(tasks.scheduled);tasks.scheduled=null;tasks.schedule=()=>{};
    const dispatch=host.provider.dispatchTurn.bind(host.provider);let dispatched=false,interrupts=0;
    // Exercise cancellation handled by the original start after its delayed ACK,
    // rather than an eager interrupt sent by the separate cancel RPC context.
    tasks.adapter.cancel=async()=>{};
    const request=host.provider.cli.request.bind(host.provider.cli);
    host.provider.cli.request=(method,...args)=>{if(method==='turn/interrupt')interrupts++;return request(method,...args);};
    host.provider.dispatchTurn=async(grant,params)=>{
      const result=await dispatch(grant,params);dispatched=true;
      await new Promise(resolve=>setTimeout(resolve,250));return result;
    };
    const project=path.join(root,'synthetic-project');fs.mkdirSync(project);
    const submitted=await tasks.call('submit_task',{requestId:'synthetic-cancel-budget',description:'Synthetic held task',acceptanceCriteria:'Synthetic cancellation',projectDirectory:project});
    const task=tasks.tasks.get(submitted.taskId);task.createdAt=Date.now()-BUDGET_MS+150;
    await tasks.tick();
    const deadline=Date.now()+5000;
    while(!dispatched && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
    assert(dispatched);
    await tasks.call('cancel_task',{taskId:task.taskId,requestId:'synthetic-cancel'});
    await tasks.idle();
    while(task.state!=='cancelled' && Date.now()<deadline){await tasks.tick();await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(task.state,'cancelled');assert(interrupts>0,'An accepted turn is interrupted even after its bootstrap deadline');
    assert.equal(host.provider.activeTurns,0,'Cancellation is confirmed by the actual CLI terminal event');
  }finally{await host?.dispose({force:true});await data.close();fs.rmSync(root,{recursive:true,force:true});}
}
(async()=>{
  await require('./provider-notifications.cjs')();
  const {startupFailure,attempt,remaining,BUDGET_MS}=require('../runtime/service-readiness.cjs');
  const waiting={createdAt:Date.now()};
  await assert.rejects(attempt(waiting,()=>{},async()=>{throw Object.assign(Error('Synthetic availability wait'),{providerWait:{reason:'active_turns'}});}));
  waiting.createdAt-=BUDGET_MS*2;waiting.readinessOrigin=waiting.createdAt;
  await attempt(waiting,()=>{},async()=>assert(remaining()>0,'An availability wait does not consume the next bootstrap budget'));
  for(const code of ['AUTH_REQUIRED','AUTH_REVOKED','PROVIDER_CONFIG_INVALID','STORE_UNAVAILABLE'])
    assert(!startupFailure(Object.assign(Error('Synthetic access refusal'),{code}),'authentication').retryable);
  await scenario(1);await scenario(2);await scenario(1,true);
  await boundedFailure('PROVIDER_UNAVAILABLE');
  await boundedFailure('BUSY_ACTIVE',{recover:true});
  await boundedFailure('PROVIDER_UNAVAILABLE',{expire:true});
  await boundedFailure('PROVIDER_UNAVAILABLE',{hang:true});
  await cancelAfterDeadline();
  console.log('PASS cold provider login: fenced account notification, single/racing submissions, bounded bootstrap queue and genuine access refusals.');
})()
  .catch(error=>{console.error(error);process.exitCode=1;});
