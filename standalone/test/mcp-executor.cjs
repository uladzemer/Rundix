const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {executor,report}=require('../runtime/mcp-executor.cjs');
const {SessionStore}=require('../runtime/store.cjs');
const {canonical,reserve,acquire}=require('../runtime/task-directory.cjs');
async function hostSendChecks(project,store) {
 const turns=[],turnLeases=new Map();let complete=true,lostReply=false;
 const noop=async()=>{};
 const context={authBusy:false,store,taskDirectory:require('../runtime/task-directory.cjs'),cwd:()=>project,
  locale:{t:text=>text},trusted:()=>true,hasChat:s=>!!s.panel,syncExternal:noop,applyPendingMode:noop,connect:noop,
  accountReadRevision:1,activeConnection:{},connections:{assertCurrent(){}},refreshAccount:async()=>false,account:{},
  limits:{updatedAt:Date.now(),buckets:[{id:'codex',windows:[{remaining:100}]}]},limitsRequest:null,refreshLimits:noop,refreshCatalog:noop,catalogUpdatedAt:Date.now(),
  updateDraftModel(){},resume:noop,
  catalog:['synthetic-default','synthetic-other'].map(model=>({model,supportedReasoningEfforts:['low','medium','high'].map(reasoningEffort=>({reasoningEffort}))})),
  preflight:{preparing:()=>false},modes:{current:()=>({id:'workspace'}),policy:()=>({})},
  speed:{effectiveTier:(_,fast)=>fast?'fast':'default'},buildInput:text=>[{type:'text',text}],turnLeases,publish(){},
  server:{request:async(method,params)=>{
   // An uncertain start is reconciled by listing turns; the synthetic turn already finished.
   if(method==='thread/turns/list')return {data:[{id:'synthetic-host-turn-'+turns.length,status:'completed'}]};
   assert.equal(method,'turn/start');turns.push(params);
   if(lostReply)throw Error('Synthetic accepted turn response lost');
   if(complete){s.busy=false;s.turnId=null;turnLeases.get(s.id)?.();turnLeases.delete(s.id);}
   return {turn:{id:'synthetic-host-turn-'+turns.length}};
  }},
 };
 const send=(...args)=>require('../runtime/send-queue.cjs').send(context,...args);
 const s={id:'synthetic-host-chat',cwd:project,loaded:true,busy:false,model:'synthetic-default',effort:'low',prefs:{fast:true},attachments:[],items:[]};
 const result=await send(s,'Synthetic effort-only host input',[],{modelSelection:{effort:'high'},includeIde:false});
 assert.equal(result.turnId,'synthetic-host-turn-1','Host returns accepted turn ID even if it already completed');
 assert.equal(s.turnId,null);
 assert.equal(turns[0].model,'synthetic-default');assert.equal(turns[0].effort,'high');
 assert.equal(turns[0].collaborationMode.settings.reasoning_effort,'high');assert.equal(turns[0].serviceTierForTurn,'fast');
 await send(s,'Synthetic defaults',[],{includeIde:false});
 assert.equal(turns[1].effort,'low');assert.equal(turns[1].model,'synthetic-default');
 const ordinaryInstructions=turns[1].collaborationMode.settings.developer_instructions;
 assert.match(ordinaryInstructions,/ask a concise structured quiz using request_user_input or request_user_input_async/);
 assert.doesNotMatch(ordinaryInstructions,/automated agent client/);
 await send(s,'Synthetic explicit model',[],{modelSelection:{model:'synthetic-other',effort:'medium',fast:false},includeIde:false});
 assert.equal(turns[2].model,'synthetic-other');assert.equal(turns[2].effort,'medium');assert.equal(turns[2].serviceTierForTurn,'default');

 complete=false;
 const task={taskId:'synthetic-host-task',sessionKey:'synthetic-host-session',projectDirectory:project,connection:{id:'synthetic-pool'}};
 const adapter=executor({connections:{selection:()=>task.connection,resolve:async()=>({...task.connection,provider:{}})},sessions:new Map([[task.sessionKey,s]]),store,
  send:(session,text,attached,options)=>send(session,text,attached,{...options,requiredConnection:undefined}),
  create(){throw Error('Unexpected creation');},pending:new Map(),save:noop,alive:()=>true});
 await assert.rejects(()=>adapter.start(task,'Synthetic checkpoint failure',()=>{if(task.turnId)throw Error('Synthetic persistence failure');}),/Synthetic persistence failure/);
 assert.equal(task.turnId,'synthetic-host-turn-4');assert.equal(s.busy,true,'Post-send checkpoint failure must preserve the active host turn');
 const agentInstructions=turns[3].collaborationMode.settings.developer_instructions;
 assert.match(agentInstructions,/requester is an automated agent client/);
 assert.match(agentInstructions,/Decide routine implementation details yourself/);
 assert.match(agentInstructions,/blocking request_user_input tool with concise options/);
 assert.match(agentInstructions,/recommended option first/);
 assert.match(agentInstructions,/Never use request_user_input_async and never wait for a human/);
 assert.throws(()=>acquire(store,project), 'Accepted turn retains its directory lease after checkpoint failure');
 turnLeases.get(s.id)();turnLeases.delete(s.id);
 s.busy=false;complete=true;
 await send(s,'Synthetic directory-only routing',[],{projectDirectory:project,includeIde:false});
 assert.equal(turns.at(-1).collaborationMode.settings.developer_instructions,agentInstructions);
 await send(s,'Synthetic task-only routing',[],{taskId:task.taskId,includeIde:false});
 assert.equal(turns.at(-1).collaborationMode.settings.developer_instructions,agentInstructions);
 await send(s,'Synthetic ordinary chat after MCP',[],{includeIde:false});
 assert.equal(turns.at(-1).collaborationMode.settings.developer_instructions,ordinaryInstructions);
 // send() itself marks failures before turn/start as notSent, including failures inside send preparation.
 const wrapped=send;
 const count=turns.length;
 for(const stage of ['authenticate','prepareTurn','model','lease']){
   context.activeConnection={provider:{authenticate:async()=>{if(stage==='authenticate')throw Error('Synthetic authentication refusal');},
     prepareTurn:async()=>{if(stage==='prepareTurn')throw Error('Synthetic preparation refusal');}}};
   const model=s.model;if(stage==='model')s.model='synthetic-unavailable-model';
   const acquire=store.acquire.bind(store);if(stage==='lease')store.acquire=key=>{if(key===s.id)throw Error('Synthetic session lease conflict');return acquire(key);};
   await assert.rejects(()=>wrapped(s,'Synthetic preparation failure',[],{includeIde:false}),error=>error.notSent===true);
   store.acquire=acquire;s.model=model;
   assert.equal(turns.length,count);
 }
 context.activeConnection={};lostReply=true;
 await assert.rejects(()=>wrapped(s,'Synthetic accepted lost reply',[],{includeIde:false}),error=>error.notSent!==true);
 assert.equal(turns.length,count+1,'Accepted RPC loss is never classified as a pre-send refusal');
 lostReply=false;
}
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-mcp-executor-synthetic-'));
 try{
  const project=canonical(root),store=new SessionStore(path.join(root,'records'));
  const bridgeLease=store.acquire('mcp-bridge'),directoryLease=store.acquire('directory-synthetic');
  store.assertNoActiveTurns();const turnLease=store.acquire('synthetic-thread');assert.throws(()=>store.assertNoActiveTurns());turnLease();directoryLease();bridgeLease();
  let selected={id:'synthetic-pool',owner:'synthetic.companion',revision:'synthetic-revision'},resumes=0,interrupts=0,retained=0,checkpointed=false;
  const s={key:'synthetic-session',id:'synthetic-chat',cwd:project,loaded:true,busy:false,turnId:null,items:[{id:'synthetic-old-report',type:'agentMessage',text:'Synthetic old result'}],prefs:{}};
  const task={taskId:'synthetic-task',sessionKey:s.key,projectDirectory:project,connection:{...selected},needsReconcile:true};
  const sessions=new Map([[s.key,s]]);
  const sent=[],sendOptions=[];let sendMode='success',turnNumber=0,turnCheckpointed=false;
  const adapter=executor({connections:{selection:()=>selected,resolve:async()=>({...selected,provider:{}}),assertCurrent(){}},sessions,store,
   create(){throw Error('Unexpected synthetic creation');},send:async(session,text,attached,options)=>{
    assert(checkpointed);assert.equal(options.projectDirectory,project);assert(options.outputSchema);
    sendOptions.push(options);
    if(sendMode==='failure')throw Error('Synthetic send failure');
    if(sendMode==='edited')session.draft='Synthetic newer draft';
    if(sendMode==='quota')return {waitUntil:1,connection:{provider:{waitForReset:async()=>false}}};
    // A fast turn may complete before turn/start responds, clearing session.turnId.
    session.turnId=null;session.busy=false;
    return {turnId:'synthetic-started-turn-'+(++turnNumber)};
   },
   resume:async session=>{resumes++;session.loaded=true;session.busy=true;session.turnId='synthetic-active-turn';},
   handle:async(session,msg)=>{if(msg.action==='stop'){assert.equal(session.turnId,'synthetic-active-turn');interrupts++;}},
   pending:new Map(),save:async()=>{},alive:()=>true,sent:async(session,text)=>{sent.push({key:session.key,text,draft:session.draft});},
   retainTurn(session){assert.equal(session.busy,true);retained++;}});
  await adapter.cancel(task);assert.equal(resumes,1);assert.equal(interrupts,1,'Ambiguous send cancellation must reconcile then interrupt');
  task.needsReconcile=true;s.loaded=true;s.busy=false;s.turnId=null;
  assert.equal((await adapter.status(task)).done,false);assert.equal(resumes,2,'Ambiguous status must read the server');
  assert.equal(retained,2,'Recovered active turns must retain cross-window leases');
  s.busy=false;s.lastTurnStatus='completed';
  await adapter.start(task,'Synthetic continuation',()=>{checkpointed=true;assert.deepEqual(task.baselineItems,['synthetic-old-report']);if(task.turnId)turnCheckpointed=true;});
  assert.equal(task.turnId,'synthetic-started-turn-1');assert(turnCheckpointed,'Started turn ID must be checkpointed even after fast completion');
  assert.equal(sendOptions.at(-1).modelSelection,undefined,'No override keeps composer defaults');
  assert.deepEqual(sent,[{key:s.key,text:'Synthetic continuation',draft:''}],'Accepted MCP input acknowledges the exact text for the owning chat');
  sendMode='edited';await adapter.start(task,'Synthetic accepted input');
  assert.equal(s.draft,'Synthetic newer draft');assert.equal(sent.at(-1).text,'Synthetic accepted input');
  for(const mode of ['failure','quota']){
   sendMode=mode;
   await assert.rejects(()=>adapter.start(task,'Synthetic unsent input'));
   assert.equal(s.draft,'Synthetic unsent input');assert.equal(sent.length,2,'Failed or cancelled sends must not clear the composer');
  }
  sendMode='success';
  s.items.push({id:'synthetic-commentary',type:'agentMessage',text:'Synthetic progress commentary'});
  s.items.push({id:'synthetic-new-report',type:'agentMessage',text:JSON.stringify({result:'Synthetic new result',changedFiles:[],checks:[],remainingIssues:[]})});
  assert.equal((await adapter.status(task)).report.result,'Synthetic new result');
  const structured=text=>JSON.stringify({result:text,changedFiles:[],checks:[],remainingIssues:[]});
  const scopedTask={turnId:'synthetic-current-turn',baselineItems:['synthetic-baseline']};
  const scopedSession={items:[
   {id:'synthetic-baseline',turnId:'synthetic-prior-turn',type:'agentMessage',text:'Synthetic baseline'},
   {id:'synthetic-old-command',turnId:'synthetic-prior-turn',type:'commandExecution',command:'synthetic-old-check',exitCode:0},
   {id:'synthetic-current-message',turnId:scopedTask.turnId,type:'agentMessage',text:'Synthetic current result'},
   {id:'synthetic-current-change',turnId:scopedTask.turnId,type:'fileChange',changes:[{path:'synthetic-current.cjs'}]},
   {id:'synthetic-current-check',turnId:scopedTask.turnId,type:'commandExecution',command:'synthetic-current-check',exitCode:0,status:'completed'},
   {id:'synthetic-late-old-json',turnId:'synthetic-prior-turn',type:'agentMessage',text:structured('Synthetic stale JSON')},
  ]};
  let evidence=report(scopedSession,scopedTask);
  assert.equal(evidence.source,'transcript_evidence');assert.equal(evidence.result,'Synthetic current result');
  assert.deepEqual(evidence.changedFiles,['synthetic-current.cjs']);assert.equal(evidence.checks.length,1);assert.equal(evidence.checks[0].command,'synthetic-current-check');
  scopedSession.cursor='synthetic-older-page';
  evidence=report(scopedSession,scopedTask);
  assert(evidence.remainingIssues.some(issue=>/evidence is incomplete/.test(issue)),'Truncated fallback must disclose missing commands and file changes');
  scopedSession.cursor=null;
  assert(!report(scopedSession,scopedTask).remainingIssues.some(issue=>/evidence is incomplete/.test(issue)));
  scopedSession.items.splice(3,0,{id:'synthetic-current-json',turnId:scopedTask.turnId,type:'agentMessage',text:structured('Synthetic scoped JSON')});
  assert.equal(report(scopedSession,scopedTask).result,'Synthetic scoped JSON','Older-turn JSON loaded later cannot replace the current report');
  assert.equal(report({items:[{id:'synthetic-baseline',type:'agentMessage',text:structured('Synthetic baseline JSON')},{id:'synthetic-unattributed',type:'agentMessage',text:'Synthetic fallback'}]},scopedTask).result,'Synthetic fallback','Unattributed transcripts retain baseline compatibility');
  task.effort='high';await adapter.start(task,'Synthetic effort-only input');
  assert.deepEqual(sendOptions.at(-1).modelSelection,{effort:'high'});
  task.model='synthetic-model';await adapter.start(task,'Synthetic model input');
  assert.deepEqual(sendOptions.at(-1).modelSelection,{model:'synthetic-model',effort:'high',fast:false});
  await hostSendChecks(project,store);
  selected={id:'local',revision:'synthetic-local'};assert.throws(()=>adapter.assertConnection());await assert.rejects(()=>adapter.cancel(task));
  selected={...task.connection,revision:'synthetic-new-revision'};await assert.rejects(()=>adapter.start(task,'Synthetic input'));
  reserve(store,project,'synthetic-task');
  const reservation=fs.readdirSync(store.directory).find(name=>name.startsWith('task-directory-'));
  fs.writeFileSync(path.join(store.directory,reservation),'{');assert.throws(()=>acquire(store,project),/unreadable/);
  console.log('MCP executor: scoped recovery, turn checkpoint/report isolation, truncation disclosure, effort-only input and administrative leases passed.');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(()=>{console.error('MCP executor synthetic checks failed.');process.exitCode=1;});
