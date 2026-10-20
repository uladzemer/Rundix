const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,execFile}=require('node:child_process');
const execFileAsync=require('node:util').promisify(execFile);
const {SessionStore}=require('../runtime/store.cjs');
const {McpTasks}=require('../runtime/mcp-tasks.cjs');
const directories=require('../runtime/task-directory.cjs');
const {serve,request,installLauncher}=require('../runtime/mcp-bridge.cjs');
const {wait,tools}=require('../runtime/mcp-server.cjs');
function adapter(overrides={}) {
  const state={done:false,requests:[],starts:0,cancels:0,answer:async()=>{}};
  return Object.assign(state,{connection:()=>({id:'synthetic-pool'}),assertConnection(){},pending:()=>state.requests,chatId:()=>'synthetic-chat',
    answer:(...a)=>state.answer(...a),async cancel(){state.cancels++;},async start(){state.starts++;state.done=false;},
    async status(){return {chatId:'synthetic-chat',done:state.done,pending:state.requests.length>0,progress:'Synthetic turn active',report:state.done?{result:'Synthetic result',changedFiles:[],checks:[],remainingIssues:[]}:null};}},overrides);
}
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-mcp-wait-synthetic-'));
  const open=[];
  try{
    const projectA=path.join(root,'synthetic-a'),projectB=path.join(root,'synthetic-b');fs.mkdirSync(projectA);fs.mkdirSync(projectB);
    const base={description:'Synthetic task',acceptanceCriteria:'Synthetic check'};
    const fresh=(name,stub=adapter())=>{const t=new McpTasks({store:new SessionStore(path.join(root,name)),adapter:stub});open.push(t);return [t,stub];};

    // Brief snapshots preserve metadata and pending requests without changing the stored report.
    const report={source:'model_report',result:'Synthetic result '.repeat(3750),changedFiles:['synthetic-a.cjs','synthetic-b.cjs'],checks:['Synthetic check A','Synthetic check B'],remainingIssues:['Synthetic issue']};
    const reportSummary={source:report.source,resultPreview:report.result.slice(0,500)+'…',resultLength:report.result.length,changedFiles:report.changedFiles,checksCount:2,remainingIssuesCount:1};
    const [compact,compactStub]=fresh('brief',adapter({async status(){return {done:this.done,report:this.done?report:null};}}));
    const compactId=compact.call('submit_task',{...base,requestId:'synthetic-brief',projectDirectory:projectA}).taskId;
    assert.equal(compact.call('get_task',{taskId:compactId,brief:true}).reportSummary,null);
    assert.equal((await compact.call('wait_task',{taskId:compactId,brief:true,waitSeconds:1})).reportSummary,null);
    await compact.tick();
    const briefWaiting=compact.call('wait_task',{taskId:compactId,brief:true,waitSeconds:5});
    compactStub.done=true;await compact.tick();
    assert.deepEqual((await briefWaiting).reportSummary,reportSummary);
    compactStub.requests=[{id:'synthetic-pending',method:'item/commandExecution/requestApproval',params:{command:'synthetic-command',description:'Synthetic permission details'}}];
    for(const name of ['get_task','wait_task']) {
      assert.deepEqual(tools.find(t=>t.name===name).inputSchema.properties.brief,{type:'boolean',default:false});
      const full=await compact.call(name,{taskId:compactId});
      assert.deepEqual(full.report,report);assert.equal(Object.hasOwn(full,'reportSummary'),false);
      assert.deepEqual(await compact.call(name,{taskId:compactId,brief:false}),full);
      const brief=await compact.call(name,{taskId:compactId,brief:true});
      const {report:omitted,...metadata}=full;
      assert.deepEqual(brief,{...metadata,reportSummary});assert.equal(Object.hasOwn(brief,'report'),false);
      assert.deepEqual(brief.pendingRequests,compactStub.requests);
      assert.throws(()=>compact.call(name,{taskId:compactId,brief:'true'}),e=>e.code==='invalid_argument');
    }
    for(const result of ['', 's'.repeat(500)]) {
      compact.get(compactId).report={...report,result};
      assert.equal(compact.call('get_task',{taskId:compactId,brief:true}).reportSummary.resultPreview,result);
    }
    compact.dispose();

    // wait_task resolves on settled states only, and polling does not churn revisions.
    let [tasks,stub]=fresh('wait');
    const first=tasks.call('submit_task',{...base,requestId:'synthetic-wait-1',projectDirectory:projectA});
    let resolved=null;const waiting=tasks.call('wait_task',{taskId:first.taskId,waitSeconds:30}).then(v=>{resolved=v;});
    await tasks.tick();await tasks.idle();assert.equal(tasks.get(first.taskId).state,'running');
    await tasks.tick();await tasks.idle();const revision=tasks.get(first.taskId).revision;await tasks.tick();await tasks.idle();await tasks.tick();await tasks.idle();
    assert.equal(tasks.get(first.taskId).revision,revision,'Unchanged polling must not save');
    await new Promise(r=>setImmediate(r));assert.equal(resolved,null,'Running is not settled');
    stub.done=true;await tasks.tick();await tasks.idle();await waiting;
    assert.equal(resolved.state,'completed');assert.equal(resolved.timedOut,false);assert.equal(resolved.report.result,'Synthetic result');
    const immediate=await tasks.call('wait_task',{taskId:first.taskId});assert.equal(immediate.state,'completed');
    const newer=await tasks.call('wait_task',{taskId:first.taskId,afterRevision:immediate.revision,waitSeconds:1});assert.equal(newer.timedOut,true,'afterRevision waits for a newer settled state');
    assert.throws(()=>tasks.call('wait_task',{taskId:first.taskId,waitSeconds:5000}),e=>e.code==='invalid_argument');
    assert.throws(()=>tasks.call('wait_task',{taskId:'synthetic-missing'}),e=>e.code==='unknown_task');

    // A replayed no-op cancellation must not cancel a later turn.
    tasks.call('cancel_task',{taskId:first.taskId,requestId:'synthetic-noop-cancel'});
    tasks.call('continue_task',{taskId:first.taskId,requestId:'synthetic-follow',clarification:'Synthetic follow-up'});
    await tasks.tick();await tasks.idle();assert.equal(tasks.get(first.taskId).state,'running');
    tasks.call('cancel_task',{taskId:first.taskId,requestId:'synthetic-noop-cancel'});
    assert.equal(stub.cancels,0);assert.notEqual(tasks.get(first.taskId).cancelRequested,true);
    stub.done=true;await tasks.tick();await tasks.idle();

    // A rejected approval reports its failure on replay instead of looking applied.
    stub.done=false;tasks.call('continue_task',{taskId:first.taskId,requestId:'synthetic-follow-2',clarification:'Synthetic second follow-up'});await tasks.tick();await tasks.idle();
    stub.requests=[{id:'synthetic-approval',method:'item/commandExecution/requestApproval'}];await tasks.tick();await tasks.idle();
    const asking=await tasks.call('wait_task',{taskId:first.taskId,waitSeconds:5});assert.equal(asking.state,'waiting_approval');
    stub.requests=[...stub.requests,{id:'synthetic-approval-2',method:'item/fileChange/requestApproval'}];await tasks.tick();await tasks.idle();
    const second=await tasks.call('wait_task',{taskId:first.taskId,afterRevision:asking.revision,waitSeconds:2});
    assert.equal(second.timedOut,false,'A new pending request must wake afterRevision waiters');assert.equal(second.pendingRequests.length,2);
    stub.requests=stub.requests.slice(0,1);await tasks.tick();await tasks.idle();
    stub.answer=async()=>{throw Error('Synthetic rejection');};
    const approval={taskId:first.taskId,requestId:'synthetic-approval-answer',approval:{id:'synthetic-approval',decision:'accept'}};
    await assert.rejects(tasks.call('continue_task',approval),e=>e.code==='approval_rejected');
    assert.throws(()=>tasks.call('continue_task',approval),e=>e.code==='approval_rejected');
    stub.requests=[];stub.done=true;await tasks.tick();await tasks.idle();

    // Compact listing with filters and a stable cursor.
    tasks.call('submit_task',{...base,requestId:'synthetic-list-2',projectDirectory:projectB});
    await new Promise(r=>setTimeout(r,5));tasks.call('submit_task',{...base,requestId:'synthetic-list-3',projectDirectory:projectB});
    const page=tasks.call('list_tasks',{limit:2});
    assert.equal(page.tasks.length,2);assert.ok(page.nextCursor);assert.equal(page.tasks[0].report,undefined);assert.equal(typeof page.tasks[0].hasReport,'boolean');
    const rest=tasks.call('list_tasks',{limit:2,cursor:page.nextCursor});assert.equal(rest.tasks.length,1);assert.equal(rest.nextCursor,null);assert.equal(rest.tasks[0].taskId,first.taskId);
    assert.equal(tasks.call('list_tasks',{state:'completed'}).tasks.length,1);
    assert.equal(tasks.call('list_tasks',{projectDirectory:projectB}).tasks.length,2);
    assert.throws(()=>tasks.call('list_tasks',{cursor:'not-a-cursor'}),e=>e.code==='invalid_argument');
    tasks.dispose();

    // A blocked directory must not stall tasks for other directories.
    [tasks,stub]=fresh('queue');
    const store=tasks.directoryStore;directories.reserve(store,projectA,'synthetic-other-owner');
    const blocked=tasks.call('submit_task',{...base,requestId:'synthetic-blocked',projectDirectory:projectA});
    const free=tasks.call('submit_task',{...base,requestId:'synthetic-free',projectDirectory:projectB});
    await tasks.tick();await tasks.idle();
    assert.equal(tasks.get(free.taskId).state,'running');assert.equal(tasks.get(blocked.taskId).state,'queued');
    assert.match(tasks.get(blocked.taskId).progress,/project directory/);
    const timed=await tasks.call('wait_task',{taskId:blocked.taskId,waitSeconds:1});assert.equal(timed.timedOut,true);assert.equal(timed.state,'queued');
    stub.done=true;await tasks.tick();await tasks.idle();directories.release(store,projectA,'synthetic-other-owner');
    tasks.dispose();

    // A stopped executor must not start a turn after an await completes.
    let release;const gate=new Promise(r=>{release=r;});
    [tasks,stub]=fresh('stopped',adapter({async status(){await gate;return {done:true};}}));
    const recovering=tasks.call('submit_task',{...base,requestId:'synthetic-recovering',projectDirectory:projectA});
    tasks.get(recovering.taskId).recoveryRequired=true;
    const ticking=tasks.tick();tasks.dispose();release();await ticking;
    assert.equal(stub.starts,0);assert.equal(tasks.get(recovering.taskId).state,'queued');
    assert.doesNotThrow(()=>directories.acquire(tasks.directoryStore,projectA,'synthetic-probe')());

    // Disposal right after a reservation releases it instead of leaking it.
    [tasks,stub]=fresh('stopped-after-reserve');
    tasks.call('submit_task',{...base,requestId:'synthetic-reserved',projectDirectory:projectA});
    const reserving=tasks.tick();tasks.dispose();await reserving;
    assert.equal(stub.starts,0);assert.doesNotThrow(()=>directories.acquire(tasks.directoryStore,projectA,'synthetic-probe')());

    // A recovered turn that is still active keeps the executor serial.
    let liveId;
    [tasks,stub]=fresh('live-recovery',adapter({async status(task){return task.taskId===liveId?{done:false}:{done:true};}}));
    liveId=tasks.call('submit_task',{...base,requestId:'synthetic-live',projectDirectory:projectA}).taskId;tasks.get(liveId).recoveryRequired=true;
    tasks.call('submit_task',{...base,requestId:'synthetic-behind-live',projectDirectory:projectB});
    await tasks.tick();await tasks.idle();assert.equal(stub.starts,0,'No second turn while a recovered turn is active');
    tasks.dispose();

    // Coded errors, long polls and the shell waiter through the real bridge.
    [tasks,stub]=fresh('bridge',adapter({async status(){return {done:this.done,report:this.done?report:null};}}));
    const bridge=await serve({directory:path.join(root,'bridge-dir'),call:(name,args)=>tasks.call(name,args)});open.push(bridge);
    await assert.rejects(request(bridge.descriptor,'get_task',{taskId:'synthetic-missing'}),e=>e.code==='unknown_task' && /Unknown taskId/.test(e.message));
    await assert.rejects(request(path.join(root,'synthetic-missing-bridge.json'),'get_task',{taskId:'x'}),e=>e.code==='bridge_unavailable' && /Start MCP bridge/.test(e.message));
    const remote=await request(bridge.descriptor,'submit_task',{...base,requestId:'synthetic-remote',projectDirectory:projectB});
    await tasks.tick();await tasks.idle();
    setTimeout(()=>{stub.done=true;void tasks.tick();},16500).unref();
    const long=await request(bridge.descriptor,'wait_task',{taskId:remote.taskId,waitSeconds:30});
    assert.equal(long.state,'completed','A wait longer than the old 12 s/15 s limits must survive');
    let output='';const sink={write:t=>{output+=t;}};
    let calls=0;
    const flaky=async(d,n,a)=>{if(++calls===1)throw Object.assign(Error('down'),{code:'bridge_unavailable'});return request(d,n,a);};
    assert.equal(await wait(bridge.descriptor,remote.taskId,30,{call:flaky,output:sink,pause:async()=>{}}),0);
    assert.equal(JSON.parse(output.trim()).state,'completed');
    assert.deepEqual(JSON.parse(output.trim()).report,report);
    output='';
    const briefCall=async(d,n,a)=>{assert.equal(a.brief,true);return request(d,n,a);};
    assert.equal(await wait(bridge.descriptor,remote.taskId,30,{call:briefCall,output:sink,brief:true}),0);
    assert.deepEqual(JSON.parse(output.trim()).reportSummary,reportSummary);
    assert.equal(Object.hasOwn(JSON.parse(output.trim()),'report'),false);
    output='';assert.equal(await wait(bridge.descriptor,'synthetic-missing',30,{output:sink}),1);assert.equal(JSON.parse(output).code,'unknown_task');
    output='';assert.equal(await wait(path.join(root,'synthetic-missing-bridge.json'),'x',1,{output:sink,pause:ms=>new Promise(r=>setTimeout(r,ms))}),4);

    // The stable launcher copy works without the versioned extension folder.
    const launcher=installLauncher(path.join(root,'launcher'),'9.9.9-synthetic');
    assert.equal(installLauncher(path.join(root,'launcher'),'9.9.9-synthetic'),launcher);
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(launcher),'version.json'))).version,'9.9.9-synthetic');
    const listed=execFileSync(process.execPath,['-e','const s=require(process.argv[1]);process.stdout.write(String(s.tools.length))',launcher],{encoding:'utf8',windowsHide:true});
    assert.equal(listed,'9');
    const cliBrief=JSON.parse((await execFileAsync(process.execPath,[launcher,'--bridge',bridge.descriptor,'--wait',remote.taskId,'--timeout','30','--brief'],{encoding:'utf8',windowsHide:true,timeout:35000})).stdout.trim());
    assert.equal(cliBrief.state,'completed');assert.deepEqual(cliBrief.reportSummary,reportSummary);assert.equal(Object.hasOwn(cliBrief,'report'),false);
    console.log('MCP wait: settled long polls, revision stability, replay-safe cancel/approval, compact listing, brief reports, queue fairness, stop safety, coded errors, shell waiter and stable launcher passed.');
  }finally{for(const item of open)item.dispose();fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error('MCP wait synthetic checks failed:',error.message);process.exitCode=1;});
