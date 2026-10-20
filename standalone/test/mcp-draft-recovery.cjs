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
  }
  console.log('MCP draft recovery: user draft preserved, failed continuations survive replacement/restart, reworded host drafts consumed.');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
};
if(require.main===module)module.exports(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1;});
