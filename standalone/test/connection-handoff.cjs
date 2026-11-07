// Synthetic connection lifecycle only: no CLI sign-in or real account is used.
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createSessionCore}=require('../runtime/session-core.cjs');
const {CONTINUE}=require('../runtime/model-capacity.cjs');
const tick=()=>new Promise(setImmediate);
async function until(check){for(let n=0;n<200;n++){if(check())return;await tick();}assert.fail('Synthetic handoff did not settle');}
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-handoff-synthetic-'));
 const transports=[],timers=new Map(),values=new Map(),calls=[];
 let core,s,account=1,now=100000,sequence=0,releaseLimits,failStart=false,blockExit=false,writerBusy=false;
 let latest={id:'synthetic-original',status:'failed',error:{codexErrorInfo:'usageLimitExceeded',message:'Synthetic limit'}};
 const model={model:'synthetic-model',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]};
 class SyntheticTransport extends EventEmitter{
  constructor(){super();this.number=transports.length+1;this.exited=new Promise(resolve=>{this.close=()=>{this.closed=true;resolve();};});transports.push(this);}
  async start(){if(failStart){this.emit('disconnected','Synthetic startup failure');throw Error('Synthetic startup failure');}return this;}
  dispose(){this.stopped=true;this.removeAllListeners();}
  async waitForExit(){if(blockExit)throw Object.assign(Error('Synthetic exit deadline'),{code:'CLI_EXIT_PENDING',retryable:true});await this.exited;}
  async request(method,params){
   calls.push({server:this.number,method,params});
   if(method==='account/read')return {account:{type:'chatgpt',email:'synthetic-'+account+'@example.test'}};
   if(method==='account/rateLimits/read'){
    if(this.number===2)await new Promise(resolve=>{releaseLimits=resolve;});
    return {rateLimits:{primary:{usedPercent:account===1?100:20,windowDurationMins:300}}};
   }
   if(method==='model/list')return {data:[model]};
   if(method==='config/read')return {config:{model:model.model,model_reasoning_effort:'medium'}};
   if(method==='thread/turns/list')return {data:[writerBusy?{id:'synthetic-retiring-writer',status:'inProgress'}:latest]};
   if(method==='thread/items/list')return {data:[]};
   if(method==='thread/resume')return {thread:{name:'Synthetic chat',cwd:root,status:{type:'idle'}},model:model.model,reasoningEffort:'medium'};
   if(method==='turn/start'){
    const turn={id:'synthetic-continuation',status:'inProgress'};
    this.emit('notification',{method:'turn/started',params:{threadId:s.id,turn}});
    return {turn};
   }
   throw Error('Unexpected synthetic method: '+method);
  }
 }
 const noop=()=>{};
 const host={paths:{storage:path.join(root,'storage')},workspaceState:{get:(k,d)=>values.get(k)??d,update:async(k,v)=>values.set(k,v)},
  settings:(_k,d)=>d,trusted:()=>true,logger:noop,events:{changed:noop,sessionChanged:noop,treeChanged:noop,notify:noop,completed:noop},
  hasChat:()=>true,isActive:()=>true,activeSession:()=>s,openChat:noop,loadSelected:noop,defaultDirectory:()=>root,editorSelection:()=>null,
  activateConnectionOwner:noop,resolveCli:async()=>path.join(root,'synthetic-cli.exe'),checkCliUpdates:noop,cliCheckPending:()=>true,
  acceptCli:noop,clearProjectFiles:noop,applyPendingMode:async()=>{},taskSessions:()=>null,createTransport:SyntheticTransport,
  clock:{now:()=>now,setTimeout:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)}};
 const provider={id:'synthetic-companion',label:'Synthetic connection',configure:noop,authenticate:async()=>{},recoversUsageLimit:()=>true,
  async prepareTurn(args){if(args.usageLimitReached){args.assertCanChange();account=2;await args.reconnect();}}};
 const starts=()=>calls.filter(row=>row.method==='turn/start');
 try{
  core=createSessionCore(host);core.connections.register('synthetic.connection',provider);core.connections.select(provider.id);
  s=core.createSession({key:'synthetic-session',saved:{id:'synthetic-thread',loaded:true,model:model.model,effort:'medium',
   lastStartedTurnId:latest.id,busy:true,turnId:latest.id,draft:'Synthetic newer draft',followUps:[{id:'synthetic-queued',text:'Synthetic queued input',attachments:[]}]}});
  await core.connect();await core.refreshLimits();
  transports[0].emit('notification',{method:'turn/completed',params:{threadId:s.id,turn:latest}});
  assert.equal(s.busy,false);assert.equal(timers.size,1);
  const timer=timers.entries().next().value;timers.delete(timer[0]);now+=timer[1].ms;timer[1].fn();
  await until(()=>transports[0].stopped);
  assert.equal(transports.length,1,'A requested stop must not start a replacement before exit');
  assert.equal(starts().length,0);
  transports[0].close();await until(()=>releaseLimits);
  assert.equal(transports.length,2);assert.equal(starts().length,0,'Fresh limits must finish before reconnect returns to preparation');
  // The previous writer may still appear in a saved snapshot. It must refuse
  // once without latching local busy forever and blocking all later retries.
  writerBusy=true;releaseLimits();await until(()=>s.limitRetry?.delaySeconds===5);
  assert.equal(s.busy,false);assert.equal(s.turnId,null);assert.equal(starts().length,0);
  writerBusy=false;
  const retry=timers.entries().next().value;timers.delete(retry[0]);now+=retry[1].ms;retry[1].fn();
  // The second preparation refreshes limits too.
  const priorRelease=releaseLimits;await until(()=>releaseLimits!==priorRelease);releaseLimits();await until(()=>{if(!s.limitRetry && s.error)throw Error(s.error);return starts().length===1 && !s.sendingTask;});
  assert.equal(starts()[0].server,2);assert.equal(starts()[0].params.threadId,'synthetic-thread');
  assert.deepEqual(starts()[0].params.input,[{type:'text',text:CONTINUE}]);
  assert.equal(s.draft,'Synthetic newer draft');assert.equal(s.followUps.length,1);assert.equal(s.limitRetry,null);
  latest={id:'synthetic-continuation',status:'completed'};
  // Prevent normal FIFO draining so this test isolates connection recovery.
  s.queuePaused=true;
  transports[1].emit('notification',{method:'turn/completed',params:{threadId:s.id,turn:latest}});
  await tick();
  // A bounded stop failure retains its process fence across manual retries.
  blockExit=true;
  await assert.rejects(core.withLocalSignIn(()=>core.resetConnection()),{code:'CLI_EXIT_PENDING'});
  assert.equal(transports.length,2);assert.equal(core.state.authBusy,false);
  blockExit=false;
  const reconnect=core.withLocalSignIn(()=>core.resetConnection());
  await tick();assert.equal(transports.length,2);
  transports[1].close();await reconnect;
  assert.equal(transports.length,3);assert.equal(s.loaded,false);assert.equal(s.draft,'Synthetic newer draft');
  // Failed startup is also retired before a later connect may create a CLI.
  transports[2].close();failStart=true;
  await assert.rejects(core.resetConnection(),/Synthetic startup failure/);
  assert.equal(transports.length,4);assert.equal(transports[3].stopped,true);
  failStart=false;const next=core.connect();await tick();assert.equal(transports.length,4);
  transports[3].close();await next;assert.equal(transports.length,5);
  // A stopped attempt waiting for exit must not create a client or clear the
  // replacement attempt's connecting/starting state when it resumes later.
  core.stopAccountServer();
  const oldAttempt=assert.rejects(core.connect(),/attempt was replaced/);
  core.stopAccountServer();const replacement=core.connect();
  transports[4].close();await oldAttempt;await replacement;
  assert.equal(transports.length,6);assert.equal(core.state.server,transports[5]);
  assert.equal(transports[5].stopped,undefined);assert.equal(core.state.connectionStarting,false);
  assert.equal(await core.connect(),transports[5]);
  console.log('PASS handoff: confirmed exit, fresh quotas, transient writer retry, same-thread continuation, preserved draft/FIFO, stop deadline and startup failure recovery.');
 }finally{
  core?.stopAccountServer();for(const client of transports)client.close();
  if(core)await core.library.queue;
  assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-handoff-synthetic-'));
  fs.rmSync(root,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
