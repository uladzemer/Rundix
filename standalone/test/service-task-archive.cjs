require('./test-isolation.cjs').isolate();
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {McpTasks}=require('../runtime/mcp-tasks.cjs');
const {SessionStore}=require('../runtime/store.cjs');
async function retention(root){
 const store=new SessionStore(path.join(root,'retention'));
 const day=86400000,hour=3600000,grace=300000,space='synthetic-retention';let time=Date.UTC(2026,0,20),tasks,resolveClose,reconnected=false;
 const adapter={assertConnection(){},connection:()=>({id:'synthetic'}),pending:task=>task.taskId==='live-pending'?[{id:'synthetic-request'}]:[],closeChat:()=>new Promise(resolve=>{resolveClose=resolve;})};
 const logs=[];
 const record=(id,extra={})=>{
   const task={taskId:id,space,description:'Synthetic retention',state:'completed',projectDirectory:root,createdAt:time-20*day,updatedAt:time-15*day,operations:[],...extra};
   store.write('mcp-task',id,task);if(tasks)tasks.tasks.set(id,task);return task;
 };
 record('old-closed',{closedAt:time-15*day,state:'cancelled'});record('old-open',{state:'error'});
 record('fresh',{updatedAt:time-day});record('boundary',{updatedAt:time+grace-14*day});
 const exclusions={queued:{state:'queued'},running:{state:'running'},approval:{state:'waiting_approval'},limit:{state:'waiting_limit'},
   recovery:{recoveryRequired:true},'live-pending':{},'saved-pending':{pendingIds:['synthetic-request']},answer:{unknownAnswer:'synthetic-answer'},
   'async-answer':{awaitingAsync:true},'pending-op':{operations:[{requestId:'synthetic-op',outcome:'pending'}]},
   queue:{continuations:['Synthetic queued continuation']},next:{nextInput:'Synthetic next input'},auto:{limitContinuation:{state:'pending'}},
   unsent:{unsentInputs:[{id:'synthetic-input',text:'Synthetic unsent text'}]},subscribed:{chatId:'synthetic-chat'},legacy:{legacy:true},readonly:{readOnly:true}};
 for(const [id,extra] of Object.entries(exclusions))record(id,extra);
 tasks=new McpTasks({store,adapter,scope:()=>space,now:()=>time,archiveLog:value=>logs.push(value),chatSubscribed:id=>reconnected && id==='subscribed'});
 tasks.schedule=()=>{};
 try{
   assert(tasks.tasks.has('old-closed'));assert(tasks.tasks.has('old-open'));
   tasks.sweepArchive();assert(tasks.tasks.has('subscribed'),'The first tick allows windows to reconnect');
   reconnected=true;
   time+=grace-1;tasks.sweepArchive();assert(tasks.tasks.has('old-open'));
   time++;tasks.sweepArchive();assert(!tasks.tasks.has('old-closed'));assert(!tasks.tasks.has('old-open'));
   assert.deepEqual([...tasks.tasks.keys()].sort(),[...Object.keys(exclusions),'fresh','boundary'].sort());
   const states=['starting','observing','reading','closing','waiting'];for(const id of states)record(id);
   tasks.starting.add('starting');tasks.observations.set('observing',Promise.resolve());
   const release=tasks.holdTask(tasks.get('reading'));
   const closing=tasks.call('close_task',{taskId:'closing'});
   const controller=new AbortController();tasks.signal=()=>controller.signal;
   const waiting=tasks.call('wait_task',{taskId:'waiting',afterRevision:0});
   time+=hour-1;tasks.sweepArchive();assert(tasks.tasks.has('boundary'));
   time++;tasks.sweepArchive();assert(!tasks.tasks.has('boundary'));
   for(const id of [...Object.keys(exclusions),...states])assert(tasks.tasks.has(id),id);
   assert.deepEqual(tasks.clearFinished(space,{dryRun:true}),{archived:2,skipped:Object.keys(exclusions).length+states.length-1,withUnsent:1});
   controller.abort();await waiting;release();resolveClose(false);await closing;
   tasks.starting.clear();tasks.observations.clear();
   time+=hour;tasks.pause();tasks.sweepArchive();assert(tasks.tasks.has('waiting'));tasks.resume();tasks.schedule=()=>{};
   const oldIds=['partial-first','partial-failed','partial-later'];for(const id of oldIds)record(id);
   let failed=false;const persist=tasks.archive.persist.bind(tasks.archive);
   tasks.archive.persist=()=>{if(!failed && tasks.archive.index.has(oldIds[1])){failed=true;throw Error('Synthetic index write failure');}persist();};
   tasks.sweepArchive();
   assert(!tasks.tasks.has(oldIds[0]));assert(tasks.tasks.has(oldIds[1]));assert(tasks.tasks.has(oldIds[2]));
   assert(store.read('mcp-task',oldIds[1]));assert.deepEqual(logs,[{code:'archive_record_unavailable'}]);
   tasks.sweepArchive();assert(tasks.tasks.has(oldIds[1]));
   time+=hour;tasks.sweepArchive();for(const id of oldIds)assert(!tasks.tasks.has(id));
   assert(tasks.tasks.has('unsent'));assert(!tasks.tasks.has('waiting'));assert(tasks.tasks.has('closing'),'Closing refreshes retention age');
   for(let i=0;i<33;i++)record('bounded-'+i);
   time+=hour;tasks.sweepArchive();assert(tasks.tasks.has('bounded-32'));
   tasks.sweepArchive();assert(!tasks.tasks.has('bounded-32'));
   const submission={requestId:'synthetic-retained-id',description:'Synthetic retained task',acceptanceCriteria:'Synthetic criteria',projectDirectory:root};
   const {taskId}=tasks.call('submit_task',submission);
   const finished=tasks.get(taskId);finished.state='completed';
   finished.report={result:'Synthetic retained report',changedFiles:[],checks:[],remainingIssues:[]};
   finished.unsentInputs=[{id:'synthetic-retained-input',text:'Synthetic retained text'}];tasks.save(finished);
   const estimate=tasks.clearFinished(space,{dryRun:true});assert.equal(estimate.withUnsent,2);
   assert.deepEqual(tasks.clearFinished(space),estimate);
   assert.equal(tasks.call('submit_task',submission).taskId,taskId);
   assert.equal(tasks.call('get_task',{taskId}).unsentInputs[0].text,'Synthetic retained text');
   assert.deepEqual(tasks.call('wait_task',{taskId}).report,finished.report);
   assert.equal(tasks.call('continue_task',{taskId,requestId:'synthetic-retained-continue',clarification:'Synthetic explicit input'}).state,'queued');
   assert.equal(tasks.tasks.get(taskId).unsentInputs[0].text,'Synthetic retained text');
 }finally{tasks.dispose();}
 console.log('PASS task retention: reconnect grace, age boundary, periodic sweep, exclusion states, pause and partial write retry');
}
function pruneClosedOnLoad(root){
 const store=new SessionStore(path.join(root,'load-closed')),space='synthetic-load-a',other='synthetic-load-b';
 const now=()=>Date.UTC(2026,0,20);
 const unsent={id:'synthetic-load-input',text:'Synthetic unsent at load'};
 const records=[
   {taskId:'older-closed',space,closedAt:now()-2,unsentInputs:[unsent],needsReconcile:true},
   {taskId:'newer-closed',space,closedAt:now()-1},
   {taskId:'other-closed',space:other,closedAt:now()-2},
   {taskId:'old-open',space,updatedAt:now()-15*86400000},
   {taskId:'recovering-closed',space,closedAt:now(),recoveryRequired:true},
 ];
 for(const record of records)store.write('mcp-task',record.taskId,{state:'completed',projectDirectory:root,operations:[],createdAt:1,updatedAt:now(),...record});
 const tasks=new McpTasks({store,scope:()=>space,adapter:{pending:()=>[]},now,keepClosed:1});
 try{
   assert.deepEqual([...tasks.tasks.keys()].sort(),['newer-closed','old-open','other-closed','recovering-closed']);
   assert.equal(store.read('mcp-task','older-closed'),null);
   assert.deepEqual(tasks.call('get_task',{taskId:'older-closed'}).unsentInputs,[unsent]);
 }finally{tasks.dispose();}
}
async function closedAtCap(root,approval=false){
 const store=new SessionStore(path.join(root,'cap-'+approval)),space='synthetic-cap';
 let rejectCancel,acceptApproval;
 const tasks=new McpTasks({store,scope:()=>space,maxStoredPerSpace:1,chatSubscribed:()=>true,
   adapter:{connection:()=>({id:'synthetic'}),assertConnection(){},
     pending:task=>task.state==='waiting_approval'?[{id:'synthetic-approval'}]:[],
     answer:()=>new Promise(resolve=>{acceptApproval=resolve;}),cancel:()=>new Promise((_,reject)=>{rejectCancel=reject;})}});
 tasks.schedule=()=>{};
 try{
   const entry={id:'synthetic-cap-input',text:'Synthetic unsent at capacity'};
   const old={taskId:'synthetic-closed-cap',space,projectDirectory:root,operations:[],state:approval?'waiting_approval':'running',createdAt:1,closedAt:2,
     needsReconcile:true,unsentInputs:[entry]};
   tasks.save(old);tasks.tasks.set(old.taskId,old);
   const response=approval?tasks.call('continue_task',{taskId:old.taskId,requestId:'synthetic-cap-answer',approval:{id:'synthetic-approval'}})
     : tasks.call('cancel_task',{taskId:old.taskId,requestId:'synthetic-cap-cancel'});
   await Promise.resolve();
   old.state='cancelled';tasks.save(old);
   assert.equal(tasks.clearFinished(space,{dryRun:true}).archived,0,'The manual action still honors chat subscriptions');
   const {taskId}=tasks.call('submit_task',{requestId:'synthetic-cap-next',projectDirectory:root,description:'Synthetic next task',acceptanceCriteria:'Synthetic criteria'});
   assert(!tasks.tasks.has(old.taskId));
   assert.deepEqual(tasks.call('get_task',{taskId:old.taskId}).unsentInputs,[entry]);
   const replacement=tasks.get(taskId);replacement.state='completed';replacement.closedAt=Date.now();tasks.save(replacement);
   const continuation='Synthetic restored cap continuation';
   tasks.call('continue_task',{taskId:old.taskId,requestId:'synthetic-cap-restore',clarification:continuation});
   if(approval){acceptApproval();await response;}
   else {rejectCancel(Error('Synthetic delayed cancellation failure'));await new Promise(resolve=>setImmediate(resolve));}
   const restored=store.read('mcp-task',old.taskId);
   assert.equal(restored.nextInput,continuation,'A late outcome must preserve a restored continuation');
   assert.equal(restored.state,'queued');
   assert(restored.operations.some(op=>op.requestId==='synthetic-cap-restore'));
   if(approval)assert.equal(restored.operations.find(op=>op.requestId==='synthetic-cap-answer').outcome,'applied');
 }finally{tasks.dispose();}
}
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-task-archive-synthetic-'));let tasks,space='synthetic-a';
 const store=new SessionStore(path.join(root,'tasks'));
 const adapter={assertConnection(){},connection:()=>({id:'synthetic'}),pending:()=>[],closeChat:async()=>false};
 const create=()=>{const value=new McpTasks({store,adapter,scope:()=>space,maxStoredPerSpace:2,keepClosed:0});value.schedule=()=>{};return value;};
 const args=id=>({requestId:id,description:'Synthetic archived task',acceptanceCriteria:'Synthetic check',projectDirectory:root});
 try{
  await retention(root);
  pruneClosedOnLoad(root);
  await closedAtCap(root);
  await closedAtCap(root,true);
  tasks=create();
  if(process.platform==='win32')for(const projectDirectory of ['\\\\.\\C:\\','\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\'])assert.throws(()=>tasks.call('submit_task',{...args('synthetic-device'),projectDirectory}),{code:'invalid_directory'});
  const a=tasks.call('submit_task',args('synthetic-a1'));tasks.call('submit_task',args('synthetic-a2'));
  assert.throws(()=>tasks.call('submit_task',args('synthetic-a3')),{code:'limit'});
  space='synthetic-b';const b=tasks.call('submit_task',args('synthetic-a1'));assert.notEqual(a.taskId,b.taskId,'Another space has independent storage capacity');
  space='synthetic-a';const record=tasks.get(a.taskId);record.lastSelection={model:'synthetic-model',displayName:'Synthetic model',effort:'medium',turnId:'synthetic-archived-turn'};record.state='completed';record.recoveryRequired=false;tasks.save(record);
  await tasks.call('close_task',{taskId:a.taskId});assert(!tasks.tasks.has(a.taskId));
  assert.equal(tasks.call('get_task',{taskId:a.taskId}).state,'completed');
   assert.deepEqual(tasks.call('get_task',{taskId:a.taskId}).lastSelection,record.lastSelection);
   assert.deepEqual(tasks.archive.page(space,{limit:3}).tasks[0].lastSelection,record.lastSelection);
  assert.equal(tasks.call('submit_task',args('synthetic-a1')).taskId,a.taskId,'Archived requestId cannot execute again');
  assert.throws(()=>tasks.call('submit_task',{...args('synthetic-a1'),description:'Synthetic conflicting retry'}),{code:'request_conflict'});
  assert.equal(tasks.call('list_tasks',{}).tasks.length,1,'Archived tasks leave active listing');
  space='synthetic-b';assert.throws(()=>tasks.call('get_task',{taskId:a.taskId}),{code:'unknown_task'});
  tasks.dispose();tasks=create();space='synthetic-a';
  assert.equal(tasks.call('submit_task',args('synthetic-a1')).taskId,a.taskId,'Dedup survives restart');
  const waiting=tasks.call('wait_task',{taskId:a.taskId,afterRevision:tasks.get(a.taskId).revision,waitSeconds:2});
  const restored=tasks.call('continue_task',{taskId:a.taskId,requestId:'synthetic-reopen',clarification:'Synthetic explicit continuation'});
  assert.equal(restored.state,'queued');assert(tasks.tasks.has(a.taskId));assert.equal(tasks.get(a.taskId).closedAt,undefined);
  assert.throws(()=>tasks.call('submit_task',args('synthetic-a3')),{code:'limit'});
  const completed=tasks.get(a.taskId);completed.state='completed';completed.recoveryRequired=false;delete completed.nextInput; // The synthetic continuation is now delivered.
  space='synthetic-b';tasks.save(completed);space='synthetic-a';
  const woke=await waiting;assert.equal(woke.timedOut,false);assert.equal(woke.revision,completed.revision,'Archived waiter follows restored object across event scopes');
  // A damaged archive index must fail closed rather than making the old request executable.
  const archived=tasks.archive;const task=tasks.get(a.taskId);task.state='completed';task.recoveryRequired=false;tasks.save(task);await tasks.call('close_task',{taskId:a.taskId});
  tasks.call('submit_task',args('synthetic-a3'));
  const cancelled=tasks.call('cancel_task',{taskId:a.taskId,requestId:'synthetic-archived-cancel'});
  assert.equal(cancelled.state,'completed');assert(!tasks.tasks.has(a.taskId),'No-op cancellation at full cap stays archived');assert(tasks.get(a.taskId).closedAt);
  assert.equal(tasks.call('cancel_task',{taskId:a.taskId,requestId:'synthetic-archived-cancel'}).revision,cancelled.revision,'Archived cancel remains idempotent');
  const key=require('node:crypto').createHash('sha256').update(space+'\0synthetic-a1').digest('hex');fs.writeFileSync(archived.store.file('request',key),'{');
  assert.throws(()=>tasks.call('submit_task',args('synthetic-a1')),{code:'storage_unavailable'});
  for(let i=0;i<125;i++)archived.put({...task,taskId:'synthetic-page-'+i,createdAt:task.createdAt+1+i,operations:[]});
  const get=archived.get.bind(archived);let reads=0;archived.get=(...args)=>{reads++;return get(...args);};
  const latest=archived.page(space,{limit:3});assert.equal(latest.tasks.length,3);assert.equal(latest.total,126);assert.equal(reads,0,'Index serves unchanged summaries without opening archived records');
  assert.equal(latest.tasks[0].taskId,'synthetic-page-124');
  const restarted=new(require('../runtime/service-task-archive.cjs').TaskArchive)(store);assert.equal(restarted.page(space,{limit:3}).total,126,'Durable index survives restart');
  const logs=[];restarted.log=value=>logs.push(value);fs.writeFileSync(restarted.store.file('mcp-task','synthetic-page-124'),'{');
  const safe=restarted.page(space,{limit:3});assert.equal(safe.tasks.length,3);assert.equal(safe.total,125);assert(!safe.tasks.some(row=>row.taskId==='synthetic-page-124'));assert.deepEqual(logs,[{code:'archive_record_corrupt'}]);
  const retainedFile=restarted.store.file('mcp-task','synthetic-page-123');
  for(const code of ['EBUSY','EPERM']){
    const stat=fs.statSync;try{fs.statSync=function(file,...args){if(file===retainedFile)throw Object.assign(Error('Synthetic archive temporarily unavailable'),{code});return stat.call(this,file,...args);};
      const transient=restarted.page(space,{limit:3});assert.equal(transient.total,125);assert(transient.tasks.some(row=>row.taskId==='synthetic-page-123'));assert(restarted.index.has('synthetic-page-123'),'Transient stat failure retains index row');
    }finally{fs.statSync=stat;}
  }
  const changedArchive=JSON.parse(fs.readFileSync(retainedFile,'utf8'));changedArchive.progress='Synthetic updated archive progress';fs.writeFileSync(retainedFile,JSON.stringify(changedArchive));
  const read=fs.readFileSync;try{fs.readFileSync=function(file,...args){if(file===retainedFile)throw Object.assign(Error('Synthetic transient archive read'),{code:'EBUSY'});return read.call(this,file,...args);};
    assert.equal(restarted.page(space,{limit:3}).total,125);assert(restarted.index.has('synthetic-page-123'),'Transient read failure retains index row');
  }finally{fs.readFileSync=read;}
  assert.equal(restarted.page(space,{limit:3}).tasks.find(row=>row.taskId==='synthetic-page-123').progress,'Synthetic updated archive progress','Next page retries the retained record');
  fs.unlinkSync(retainedFile);assert.equal(restarted.page(space,{limit:3}).total,124);assert(!restarted.index.has('synthetic-page-123'),'ENOENT removes a vanished archive row');
  const staleBlocked=[...tasks.tasks.values()].find(row=>row.space===space && row.state==='queued');assert(staleBlocked);
  staleBlocked.error='Synthetic old admission error';staleBlocked.blockedReason='legacy_owner_active';staleBlocked.blockedUntil=Date.now()+60000;
  const cancelledBlocked=tasks.call('cancel_task',{taskId:staleBlocked.taskId,requestId:'synthetic-cancel-old-block'});
  assert.equal(cancelledBlocked.state,'cancelled');assert.equal(cancelledBlocked.error,null);assert.equal(staleBlocked.blockedReason,undefined);assert.equal(staleBlocked.blockedUntil,undefined);
  console.log('PASS task archive: per-space cap, automatic closed history, archived get/isolation, persistent requestId dedup, explicit restore and damaged-index fail closed.');
 }finally{tasks?.dispose();assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-task-archive-synthetic-'));fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
