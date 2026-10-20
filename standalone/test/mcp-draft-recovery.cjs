// Synthetic continuations only; no CLI, account or editor is used.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SessionStore}=require('../runtime/store.cjs');
const {McpTasks}=require('../runtime/mcp-tasks.cjs');
const {executor}=require('../runtime/mcp-executor.cjs');
const persistence=require('../runtime/session-persistence.cjs');
const draft=require('../runtime/composer-draft.cjs');
module.exports=async(only)=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-synthetic-draft-recovery-'));
 try{
  for(const ownDraft of [true,false,'equal']){
   if(only && ownDraft==='equal')continue;
   if(only && only!==(ownDraft?'a':'b'))continue;
   const project=require('../runtime/task-directory.cjs').canonical(root);
   const store=new SessionStore(path.join(root,'records-'+String(ownDraft)));
   const connection={id:'synthetic-companion',owner:'synthetic.owner',revision:'synthetic-revision'};
   const userText=ownDraft==='equal'?'Synthetic continuation C2':'Synthetic user draft D';
   let session={key:'synthetic-session',id:'synthetic-chat',loaded:true,cwd:project,items:[],prefs:{},draft:ownDraft?userText:''};
   const sessions=new Map([[session.key,session]]);let refuse=true,acknowledgedConsumption;
   const save=s=>persistence.save({store,workspaceState:{update:async()=>{}}},s);
   const adapter=executor({connections:{selection:()=>connection,resolve:async()=>({...connection,provider:{}})},
    sessions,store,save,alive:()=>true,pending:new Map(),send:async()=>{
     if(refuse)throw Object.assign(Error('Synthetic definite preparation refusal'),{notSent:true});
     return {turnId:'synthetic-accepted-turn'};
    },sent:async(_session,_text,options)=>{acknowledgedConsumption=options.consumeDraft;}});
   let tasks=new McpTasks({store,adapter});
   const task={taskId:'synthetic-task',sessionKey:session.key,projectDirectory:project,connection,state:'completed',
    operations:[],description:'Synthetic task',acceptanceCriteria:'Synthetic acceptance',createdAt:1};
   tasks.tasks.set(task.taskId,task);tasks.save(task);
   const continueWith=(requestId,clarification)=>{const value=tasks.call('continue_task',{taskId:task.taskId,requestId,clarification});clearTimeout(tasks.scheduled);tasks.scheduled=null;return value;};
   try{
    continueWith('synthetic-request-c1','Synthetic continuation C1');await tasks.start(task);
    assert.equal(task.state,'error');
    if(ownDraft){
     assert.equal(session.draft,userText);
     assert((tasks.call('get_task',{taskId:task.taskId}).unsentInputs || []).some(row=>row.text==='Synthetic continuation C1'),
      'A: failed C1 must be recoverable without replacing user draft D');
    }else assert.equal(session.draft,'Synthetic continuation C1');
    // Reopen from persisted session state, rather than relying on an in-memory marker.
    session={...store.session(session.key),loaded:true};sessions.set(session.key,session);
    continueWith('synthetic-request-c2','Synthetic continuation C2');refuse=false;await tasks.start(task);
    assert.equal(session.draft,ownDraft?userText:'',
     'B: delivered C2 must replace and consume an unedited host-owned failed C1');
    assert.equal(acknowledgedConsumption,!ownDraft,'The acknowledgement preserves runtime user ownership, even for equal text');
    tasks.dispose();tasks=new McpTasks({store,adapter});
    assert((tasks.call('get_task',{taskId:task.taskId}).unsentInputs || []).some(row=>row.text==='Synthetic continuation C1'),
     'Failed C1 stays recoverable after a newer continuation and service restart');
   }finally{tasks.dispose();}
  }
  if(!only){
   for(const failure of ['wait','current','selection','cancel','unknown','unknown-unmarked','retry-unknown','accepted']){
    const connection={id:'synthetic-companion',owner:'synthetic.owner',revision:'synthetic-revision'};
    const project=require('../runtime/task-directory.cjs').canonical(root);
    const store=new SessionStore(path.join(root,'wait-'+failure));let changed=false,attempts=0;
    const session={key:'synthetic-wait',id:'synthetic-chat',loaded:true,cwd:project,items:[],prefs:{},draft:'Synthetic user draft'};
    const adapter=executor({connections:{selection:()=>changed?{...connection,revision:'synthetic-other'}:connection,
     resolve:async()=>({...connection,provider:{}}),assertCurrent(){if(failure==='current')throw Error('Synthetic connection changed');}},
     sessions:new Map([[session.key,session]]),store,save:async()=>{},pending:new Map(),alive:()=>true,
     send:async()=>{
      attempts++;
      if(failure==='unknown')throw Object.assign(Error('Synthetic lost turn response'),{deliveryUncertain:true});
      if(failure==='unknown-unmarked' || failure==='retry-unknown' && attempts>1)throw Error('Synthetic unclassified lost turn response');
      if(failure==='accepted')return {turnId:'synthetic-accepted'};
      return {waitUntil:1,connection:{provider:{waitForReset:async()=>{
       if(failure==='wait')throw Error('Synthetic wait interrupted');
       if(failure==='selection')changed=true;return failure!=='cancel';
      }}}};
     },sent:async()=>{if(failure==='accepted')throw Error('Synthetic post-delivery failure');}});
    const tasks=new McpTasks({store,adapter});
    const task={taskId:'synthetic-wait-task',sessionKey:session.key,projectDirectory:project,connection,operations:[],state:'queued',nextInput:'Synthetic interrupted continuation'};
    tasks.tasks.set(task.taskId,task);
    try{
     await tasks.start(task);
     const safe=!['unknown','unknown-unmarked','retry-unknown','accepted'].includes(failure);
     assert.equal(task.recoveryRequired,!safe,'Interrupted wait is definitely unsent; requested/accepted turns remain quarantined: '+failure);
     assert.equal((task.unsentInputs || []).some(row=>row.text==='Synthetic interrupted continuation'),safe);
    }finally{tasks.dispose();}
   }
   const connection={id:'synthetic-companion',owner:'synthetic.owner',revision:'synthetic-revision'};
   const project=require('../runtime/task-directory.cjs').canonical(root);
   for(const failure of ['save','sent']){
    const session={key:'synthetic-checkpoint',id:'synthetic-chat',loaded:true,cwd:project,items:[],prefs:{},draft:''};
    const task={taskId:'synthetic-checkpoint-task',sessionKey:session.key,projectDirectory:project,connection};
    let accepted=false,checkpointed=null;
    const adapter=executor({connections:{selection:()=>connection,resolve:async()=>({...connection,provider:{}})},
     sessions:new Map([[session.key,session]]),store:{},pending:new Map(),alive:()=>true,
     save:async()=>{if(accepted && failure==='save')throw Error('Synthetic post-send save failure');},
     send:async()=>{accepted=true;return {turnId:'synthetic-checkpoint-turn'};},
     sent:async()=>{if(failure==='sent')throw Error('Synthetic post-send acknowledgement failure');}});
    await assert.rejects(adapter.start(task,'Synthetic checkpoint input',()=>{if(task.turnId)checkpointed=task.turnId;}));
    assert.equal(checkpointed,'synthetic-checkpoint-turn','Turn checkpoint runs despite '+failure+' failure');
   }
   const session={draft:'Synthetic user text'};
   assert.equal(draft.prepare(session,'Synthetic automated text'),false);
   draft.userEdit(session,'');draft.prepare(session,'Synthetic C1');
   const before=draft.snapshot(session);
   draft.userEdit(session,'Synthetic intermediate',{explicit:true});draft.userEdit(session,'Synthetic C1',{explicit:true});
   assert.equal(draft.consume(session,before),false,'Editing back to equal text invalidates host consumption');
   assert.equal(draft.prepare(session,'Synthetic C2'),false,'User ownership prevents continuation replacement');
   const recovery=require('../runtime/mcp-input-recovery.cjs'),task={};
   for(let index=0;index<23;index++)recovery.remember(task,'Synthetic recoverable input '+index);
   let after,seen=[];
   do{const page=recovery.page(task,after);seen.push(...page.unsentInputs);after=page.nextUnsentCursor;}while(after);
   assert.equal(seen.length,23);assert.equal(new Set(seen.map(row=>row.id)).size,23,'All recovery pages remain accessible');
   for(let index=23;index<90;index++)recovery.remember(task,'Synthetic recoverable input '+index);
   assert.equal(task.unsentInputs.length,50);assert.equal(task.unsentInputs[0].text,'Synthetic recoverable input 40');
   const large={};for(let index=0;index<30;index++)recovery.remember(large,'Synthetic '+index+' '+ 'x'.repeat(100000));
   assert(Buffer.byteLength(JSON.stringify(large.unsentInputs))<=recovery.MAX_BYTES);
   assert(large.unsentInputs.length<30 && large.unsentInputs.at(-1).text.startsWith('Synthetic 29 '));
   const store=new SessionStore(path.join(root,'snapshots'));
   const adapter={pending:()=>[],assertConnection(){},connection:()=>connection,cancel:async()=>{}};
   const tasks=new McpTasks({store,adapter});
   const record={taskId:'synthetic-snapshot',sessionKey:'synthetic-snapshot-chat',projectDirectory:project,
    connection,state:'completed',operations:[],description:'Synthetic snapshot',createdAt:1};
   recovery.remember(record,'Synthetic private recovery text');tasks.tasks.set(record.taskId,record);tasks.save(record);
   const compact=value=>{assert(!JSON.stringify(value).includes('Synthetic private recovery text'));assert.equal(value.unsentInputCount,1);};
   const call=(name,args)=>{const value=tasks.call(name,args);clearTimeout(tasks.scheduled);tasks.scheduled=null;return value;};
   try{
    compact(call('get_task',{taskId:record.taskId,brief:true}));
    compact(await call('wait_task',{taskId:record.taskId,waitSeconds:1}));
    compact((await call('wait_tasks',{taskIds:[record.taskId],waitSeconds:1})).settled[0]);
    compact(call('cancel_task',{taskId:record.taskId,requestId:'synthetic-noop-cancel'}));
    assert.equal(call('get_task',{taskId:record.taskId}).unsentInputs[0].text,'Synthetic private recovery text');
    compact(call('continue_task',{taskId:record.taskId,requestId:'synthetic-queue-next',clarification:'Synthetic queued next'}));
    record.continuations=['Synthetic queued follow-up'];
    const cancelled=call('cancel_task',{taskId:record.taskId,requestId:'synthetic-queued-cancel'});
    assert.equal(cancelled.unsentInputCount,3);assert(!JSON.stringify(cancelled).includes('Synthetic queued next'));
    assert.deepEqual(call('get_task',{taskId:record.taskId}).unsentInputs.map(row=>row.text),
     ['Synthetic private recovery text','Synthetic queued next','Synthetic queued follow-up']);
    const running={...record,taskId:'synthetic-running',state:'running',recoveryRequired:true,
     unsentInputs:[],nextInput:'Synthetic ambiguous active input',continuations:['Synthetic safely queued input'],operations:[]};
    tasks.tasks.set(running.taskId,running);
    call('cancel_task',{taskId:running.taskId,requestId:'synthetic-active-cancel'});
    assert.deepEqual(running.unsentInputs.map(row=>row.text),['Synthetic safely queued input']);
    const submit=call('submit_task',{requestId:'synthetic-new-submit',description:'Synthetic new task',acceptanceCriteria:'Synthetic acceptance',projectDirectory:project});
    assert.equal(submit.unsentInputCount,0);assert(!('unsentInputs' in submit));
    // Existing oversized recovery records are bounded on restart too.
    record.unsentInputs=task.unsentInputs.concat(task.unsentInputs);tasks.save(record);
   }finally{tasks.dispose();}
   const restarted=new McpTasks({store,adapter});
   try{assert.equal(restarted.get(record.taskId).unsentInputs.length,50);}finally{restarted.dispose();}
  }
  console.log('MCP draft recovery: user draft preserved, failed continuations survive replacement/restart, reworded host drafts consumed.');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
};
if(require.main===module)module.exports(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1;});
