const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {executor}=require('../runtime/mcp-executor.cjs');
const {SessionStore}=require('../runtime/store.cjs');
const {canonical,reserve,acquire}=require('../runtime/task-directory.cjs');
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
  const sent=[];let sendMode='success';
  const adapter=executor({connections:{selection:()=>selected,assertCurrent(){}},sessions,store,
   create(){throw Error('Unexpected synthetic creation');},send:async(session,text,attached,options)=>{
    assert(checkpointed);assert.equal(options.projectDirectory,project);assert(options.outputSchema);
    if(sendMode==='failure')throw Error('Synthetic send failure');
    if(sendMode==='edited')session.draft='Synthetic newer draft';
    if(sendMode==='quota')return {waitUntil:1,connection:{provider:{waitForReset:async()=>false}}};
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
  await adapter.start(task,'Synthetic continuation',()=>{checkpointed=true;assert.deepEqual(task.baselineItems,['synthetic-old-report']);});
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
  selected={id:'local',revision:'synthetic-local'};assert.throws(()=>adapter.assertConnection());await assert.rejects(()=>adapter.cancel(task));
  selected={...task.connection,revision:'synthetic-new-revision'};await assert.rejects(()=>adapter.start(task,'Synthetic input'));
  reserve(store,project,'synthetic-task');
  const reservation=fs.readdirSync(store.directory).find(name=>name.startsWith('task-directory-'));
  fs.writeFileSync(path.join(store.directory,reservation),'{');assert.throws(()=>acquire(store,project),/unreadable/);
  console.log('MCP executor: scoped recovery, ambiguous cancellation, baseline checkpoint, pool-only boundary and administrative leases passed.');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(()=>{console.error('MCP executor synthetic checks failed.');process.exitCode=1;});
