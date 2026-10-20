const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SessionStore}=require('../runtime/store.cjs');
const {McpTasks}=require('../runtime/mcp-tasks.cjs');
const {wait}=require('../runtime/mcp-server.cjs');
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-mcp-parallel-synthetic-'));
  const open=[];
  try{
    const dirs=['a','b','c','d'].map(name=>{const dir=path.join(root,'synthetic-'+name);fs.mkdirSync(dir);return dir;});
    const done=new Set(),started=[];
    const adapter={connection:()=>({id:'synthetic-pool'}),assertConnection(){},pending:()=>[],chatId:task=>'synthetic-chat-'+task.taskId,
      answer:async()=>{},cancel:async()=>{},async start(task){started.push(task.taskId);},
      async status(task){const finished=done.has(task.taskId);return {chatId:'synthetic-chat-'+task.taskId,done:finished,pending:false,progress:'Synthetic turn active',report:finished?{result:'Synthetic result',changedFiles:[],checks:[],remainingIssues:[]}:null};}};
    let limit=3;
    const tasks=new McpTasks({store:new SessionStore(path.join(root,'records')),adapter,maxParallel:()=>limit});open.push(tasks);
    const base={description:'Synthetic task',acceptanceCriteria:'Synthetic check'};
    const submit=(id,dir)=>tasks.call('submit_task',{...base,requestId:'synthetic-'+id,projectDirectory:dir}).taskId;
    const ids=[submit('1',dirs[0]),submit('2',dirs[1]),submit('3',dirs[2]),submit('4',dirs[3]),submit('5',dirs[0])];
    await tasks.tick();await tasks.idle();
    assert.deepEqual(started,ids.slice(0,3),'Three different directories start together, in submission order');
    assert.equal(tasks.get(ids[3]).state,'queued');assert.equal(tasks.get(ids[4]).state,'queued');

    // wait_tasks wakes on the first task that settles and reports the rest as waiting.
    const waiting=tasks.call('wait_tasks',{taskIds:ids.slice(0,3),waitSeconds:10,brief:true});
    done.add(ids[1]);await tasks.tick();await tasks.idle();
    const woke=await waiting;
    assert.equal(woke.timedOut,false);assert.deepEqual(woke.settled.map(t=>t.taskId),[ids[1]]);assert.equal(woke.settled[0].reportSummary.resultPreview,'Synthetic result');
    assert.deepEqual(woke.waiting,[ids[0],ids[2]]);
    assert.ok(started.includes(ids[3]),'A freed slot starts the next queued task in the same tick');
    assert.equal(tasks.get(ids[4]).state,'queued','The same directory stays serial');
    done.add(ids[0]);await tasks.tick();await tasks.idle();assert.ok(started.includes(ids[4]),'The directory frees for its next task');
    assert.throws(()=>tasks.call('wait_tasks',{taskIds:[]}),e=>e.code==='invalid_argument');
    assert.throws(()=>tasks.call('wait_tasks',{taskIds:[ids[0],ids[0]]}),e=>e.code==='invalid_argument');
    assert.throws(()=>tasks.call('wait_tasks',{taskIds:['synthetic-missing']}),e=>e.code==='unknown_task');
    const timed=await tasks.call('wait_tasks',{taskIds:[ids[2]],waitSeconds:1});assert.equal(timed.timedOut,true);assert.deepEqual(timed.settled,[]);

    // Limits are clamped; a broken setting means serial execution.
    limit=99;assert.equal(tasks.limit(),5);limit='synthetic';assert.equal(tasks.limit(),1);limit=0;assert.equal(tasks.limit(),1);

    // A start that waits (for example for a quota reset) must not freeze other tasks, and a retryable failure requeues.
    {
      const dirsB=['e','f','g'].map(name=>{const dir=path.join(root,'synthetic-'+name);fs.mkdirSync(dir);return dir;});
      let releaseSlow;const slowGate=new Promise(r=>{releaseSlow=r;});let failOnce=true;const finished=new Set(),begun=[];
      const slowAdapter={...adapter,async start(task){begun.push(task.taskId);
          if(task.description==='Synthetic slow')await slowGate;
          if(task.description==='Synthetic busy' && failOnce){failOnce=false;throw Object.assign(Error('Synthetic busy connection'),{retryable:true});}},
        async status(task){const ok=finished.has(task.taskId);return {chatId:'synthetic',done:ok,pending:false,report:ok?{result:'Synthetic result',changedFiles:[],checks:[],remainingIssues:[]}:null};}};
      const parallel=new McpTasks({store:new SessionStore(path.join(root,'records-slow')),adapter:slowAdapter,maxParallel:()=>3});open.push(parallel);
      const fast=parallel.call('submit_task',{...base,requestId:'synthetic-fast',projectDirectory:dirsB[0]}).taskId;
      const slow=parallel.call('submit_task',{...base,description:'Synthetic slow',requestId:'synthetic-slow',projectDirectory:dirsB[1]}).taskId;
      const busy=parallel.call('submit_task',{...base,description:'Synthetic busy',requestId:'synthetic-busy',projectDirectory:dirsB[2]}).taskId;
      await parallel.tick();await new Promise(r=>setImmediate(r));
      assert.equal(parallel.get(busy).state,'queued','A retryable failure before sending returns the task to the queue');
      assert.equal(parallel.get(busy).recoveryRequired,false);assert.match(parallel.get(busy).progress,/busy/);
      finished.add(fast);await parallel.tick();
      assert.equal(parallel.get(fast).state,'completed','Other tasks are observed while one start is still waiting');
      assert.equal(parallel.get(slow).state,'running');
      parallel.get(busy).blockedUntil=0;await parallel.tick();await new Promise(r=>setImmediate(r));
      assert.equal(begun.filter(id=>id===busy).length,2,'The requeued task starts again');
      releaseSlow();await parallel.idle();
    }

    // The shell waiter accepts several IDs and reports the most urgent outcome.
    let output='';const sink={write:text=>{output+=text;}};
    const fake=async(_d,name,args)=>{assert.equal(name,'wait_tasks');assert.deepEqual(args.taskIds,['synthetic-x','synthetic-y']);
      return {settled:[{taskId:'synthetic-x',state:'completed'},{taskId:'synthetic-y',state:'waiting_approval'}],waiting:[],timedOut:false};};
    assert.equal(await wait('synthetic-bridge.json','synthetic-x,synthetic-y',30,{call:fake,output:sink}),2);
    assert.equal(JSON.parse(output).settled.length,2);
    output='';
    assert.equal(await wait('synthetic-bridge.json','synthetic-x,synthetic-y',30,{call:async()=>({settled:[{taskId:'synthetic-x',state:'completed'}],waiting:['synthetic-y'],timedOut:false}),output:sink}),0);
    console.log('MCP parallel: bounded concurrency across directories, per-directory order, wait_tasks wake-up, limit clamping and multi-task shell waiter passed.');
  }finally{for(const item of open)item.dispose();fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error('MCP parallel synthetic checks failed:',error.message);process.exitCode=1;});
