const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {McpTasks}=require('../runtime/mcp-tasks.cjs');
const {SessionStore}=require('../runtime/store.cjs');
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-task-archive-synthetic-'));let tasks,space='synthetic-a';
 const store=new SessionStore(path.join(root,'tasks'));
 const adapter={assertConnection(){},connection:()=>({id:'synthetic'}),pending:()=>[],closeChat:async()=>false};
 const create=()=>{const value=new McpTasks({store,adapter,scope:()=>space,maxStoredPerSpace:2,keepClosed:0});value.schedule=()=>{};return value;};
 const args=id=>({requestId:id,description:'Synthetic archived task',acceptanceCriteria:'Synthetic check',projectDirectory:root});
 try{
  tasks=create();
  if(process.platform==='win32')for(const projectDirectory of ['\\\\.\\C:\\','\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\'])assert.throws(()=>tasks.call('submit_task',{...args('synthetic-device'),projectDirectory}),{code:'invalid_directory'});
  const a=tasks.call('submit_task',args('synthetic-a1'));tasks.call('submit_task',args('synthetic-a2'));
  assert.throws(()=>tasks.call('submit_task',args('synthetic-a3')),{code:'limit'});
  space='synthetic-b';const b=tasks.call('submit_task',args('synthetic-a1'));assert.notEqual(a.taskId,b.taskId,'Another space has independent storage capacity');
  space='synthetic-a';const record=tasks.get(a.taskId);record.state='completed';record.recoveryRequired=false;tasks.save(record);
  await tasks.call('close_task',{taskId:a.taskId});assert(!tasks.tasks.has(a.taskId));
  assert.equal(tasks.call('get_task',{taskId:a.taskId}).state,'completed');
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
  const completed=tasks.get(a.taskId);completed.state='completed';completed.recoveryRequired=false;
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
  const staleBlocked=[...tasks.tasks.values()].find(row=>row.space===space && row.state==='queued');assert(staleBlocked);
  staleBlocked.error='Synthetic old admission error';staleBlocked.blockedReason='legacy_owner_active';staleBlocked.blockedUntil=Date.now()+60000;
  const cancelledBlocked=tasks.call('cancel_task',{taskId:staleBlocked.taskId,requestId:'synthetic-cancel-old-block'});
  assert.equal(cancelledBlocked.state,'cancelled');assert.equal(cancelledBlocked.error,null);assert.equal(staleBlocked.blockedReason,undefined);assert.equal(staleBlocked.blockedUntil,undefined);
  console.log('PASS task archive: per-space cap, automatic closed history, archived get/isolation, persistent requestId dedup, explicit restore and damaged-index fail closed.');
 }finally{tasks?.dispose();assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-task-archive-synthetic-'));fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
