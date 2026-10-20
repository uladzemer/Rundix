const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const {SessionStore}=require('../runtime/store.cjs');
const {McpTasks}=require('../runtime/mcp-tasks.cjs');
const directories=require('../runtime/task-directory.cjs');
const {serve,request}=require('../runtime/mcp-bridge.cjs');
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-mcp-synthetic-'));
 let tasks,bridge,child;
 try{
  const project=path.join(root,'synthetic-project');fs.mkdirSync(project);
  const store=new SessionStore(path.join(root,'records'));
  let sends=0,done=false,pending=false,cancels=0,cancelled=false;
  const adapter={connection:()=>({id:'synthetic-pool'}),assertConnection(){},pending:()=>pending?[{id:'synthetic-approval'}]:[],
   async answer(){pending=false;},async cancel(){cancels++;done=true;cancelled=true;},chatId:()=> 'synthetic-chat',
   async start(task){sends++;task.chatId='synthetic-chat';done=false;cancelled=false;},
   async status(){return {chatId:'synthetic-chat',done,pending,cancelled,report:{result:'Synthetic result',changedFiles:['synthetic.js'],checks:['Synthetic check passed'],remainingIssues:[]}};}};
  tasks=new McpTasks({store,adapter});
  const args={requestId:'synthetic-submit',description:'Synthetic task',acceptanceCriteria:'Synthetic check',projectDirectory:project};
  const first=tasks.call('submit_task',args);assert.equal(first.state,'queued');assert.equal(sends,0);
  assert.equal(tasks.call('submit_task',args).taskId,first.taskId);
  assert.equal(tasks.call('submit_task',{acceptanceCriteria:args.acceptanceCriteria,projectDirectory:project,description:args.description,requestId:args.requestId}).taskId,first.taskId);
  assert.throws(()=>tasks.call('submit_task',{...args,description:'Different synthetic task'}),/requestId/);
  await tasks.tick();assert.equal(sends,1);
  assert.equal(tasks.get(first.taskId).recoveryRequired,true,'In-flight marker must persist for restart reconciliation');
  assert.equal(tasks.call('get_task',{taskId:first.taskId}).recoveryRequired,false,'Normal execution must not report recovery');
  if(process.platform==='win32')assert.equal(directories.canonical(project.toUpperCase()),directories.canonical(project),'Directory case must map to one reservation');
  assert.throws(()=>directories.acquire(store,project),/reserved/);
  pending=true;await tasks.tick();assert.equal(tasks.call('get_task',{taskId:first.taskId}).state,'waiting_approval');
  await tasks.call('continue_task',{taskId:first.taskId,requestId:'synthetic-approval',approval:{id:'synthetic-approval',decision:'accept'}});
  done=true;await tasks.tick();assert.equal(tasks.get(first.taskId).state,'completed');
  const unlock=directories.acquire(store,project);unlock();
  const follow={taskId:first.taskId,requestId:'synthetic-continue',clarification:'Synthetic continuation'};
  tasks.call('continue_task',follow);await tasks.tick();assert.equal(sends,2);assert.equal(tasks.get(first.taskId).chatId,'synthetic-chat');
  tasks.call('continue_task',follow);assert.equal(sends,2);
  tasks.dispose();tasks=new McpTasks({store,adapter});await tasks.tick();assert.equal(sends,2,'Restart must observe, never resend');
  tasks.call('cancel_task',{taskId:first.taskId,requestId:'synthetic-cancel'});await new Promise(r=>setImmediate(r));await tasks.tick();
  assert.equal(cancels,1);assert.equal(tasks.get(first.taskId).state,'cancelled');
  tasks.call('submit_task',{...args,requestId:'synthetic-second'});await tasks.tick();
  const queued=tasks.call('submit_task',{...args,requestId:'synthetic-third'});await tasks.tick();assert.equal(tasks.get(queued.taskId).state,'queued');
  assert.equal(sends,3,'Serial queue must not start a second task');
  tasks.call('cancel_task',{taskId:queued.taskId,requestId:'synthetic-cancel-queued'});assert.equal(tasks.get(queued.taskId).state,'cancelled');
  const running=[...tasks.tasks.values()].find(t=>t.state==='running');
  running.state='error';running.recoveryRequired=true;tasks.save(running);
  tasks.call('cancel_task',{taskId:running.taskId,requestId:'synthetic-recovery-cancel'});await new Promise(r=>setImmediate(r));await tasks.tick();assert.equal(running.state,'cancelled');
  const next=tasks.call('submit_task',{...args,requestId:'synthetic-queued-follow'});await tasks.tick();
  tasks.call('continue_task',{taskId:next.taskId,requestId:'synthetic-active-follow',clarification:'Synthetic queued clarification'});
  assert.equal(tasks.view(tasks.get(next.taskId)).queuedContinuations,1);done=true;await tasks.tick();assert.equal(sends,5);assert.equal(tasks.get(next.taskId).chatId,'synthetic-chat');
  tasks.dispose();
  bridge=await serve({directory:path.join(root,'bridge'),call:(name,args)=>({name,args,synthetic:true})});
  assert.equal((await request(bridge.descriptor,'get_task',{taskId:'synthetic'})).synthetic,true);
  const config=JSON.parse(fs.readFileSync(bridge.descriptor));
  const forbidden=await new Promise(resolve=>{const req=http.request({host:'127.0.0.1',port:config.port,path:'/call',method:'POST'},res=>{res.resume();resolve(res.statusCode);});req.end('{}');});
  assert.equal(forbidden,403);
  const origin=await new Promise(resolve=>{const req=http.request({host:'127.0.0.1',port:config.port,path:'/call',method:'POST',headers:{Authorization:'Bearer '+config.secret,Origin:'https://example.test'}},res=>{res.resume();resolve(res.statusCode);});req.end('{}');});assert.equal(origin,403);
  child=spawn(process.execPath,[path.join(__dirname,'../runtime/mcp-server.cjs'),'--bridge',bridge.descriptor],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let buffer='',seq=0;const replies=new Map();child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);replies.get(m.id)?.(m);}});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error('Synthetic MCP timeout')),5000);replies.set(id,m=>{clearTimeout(timer);replies.delete(id);resolve(m);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  assert.equal((await rpc('initialize',{protocolVersion:'2025-11-25'})).result.protocolVersion,'2025-11-25');
  assert.equal((await rpc('tools/list')).result.tools.length,6);
  const response=await rpc('tools/call',{name:'get_task',arguments:{taskId:'synthetic'}});assert.equal(JSON.parse(response.result.content[0].text).name,'get_task');
  assert.equal((await rpc('tools/call',{name:'submit_task',arguments:{}})).result.isError,true);
  console.log('MCP synthetic persistence, replay, queue, approvals, cancellation, directory and authenticated stdio checks passed.');
 }finally{tasks?.dispose();child?.kill();bridge?.dispose();fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(()=>{console.error('MCP synthetic checks failed.');process.exitCode=1;});
