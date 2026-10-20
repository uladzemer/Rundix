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
  tasks=create();const a=tasks.call('submit_task',args('synthetic-a1'));tasks.call('submit_task',args('synthetic-a2'));
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
  console.log('PASS task archive: per-space cap, automatic closed history, archived get/isolation, persistent requestId dedup, explicit restore and damaged-index fail closed.');
 }finally{tasks?.dispose();assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-task-archive-synthetic-'));fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
