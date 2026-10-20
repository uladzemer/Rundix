// Synthetic Node-only integration: real session core, scheduler and executor;
// fake CLI and bridge transports. Loading editor APIs is forbidden.
const assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {EventEmitter}=require('node:events');
const Module=require('node:module'), originalLoad=Module._load;
Module._load=function(name,...args){assert.notEqual(name,'vscode');return originalLoad.call(this,name,...args);};
const {createSessionCore}=require('../runtime/session-core.cjs');
const {createMcpHost}=require('../runtime/mcp-host.cjs');
const {SessionStore}=require('../runtime/store.cjs');
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-mcp-host-synthetic-'));
  const visible=new Set(), values=new Map(), calls=[];
  const noop=()=>{};
  const timers=new Map(), uiEvents=[], settings=new Map();
  let reloads=0, savedTabKey;
  const clock={setTimeout(callback,delay){const timer={callback,delay};timers.set(timer,timer);return timer;},
    clearTimeout(timer){timers.delete(timer);}};
  const fireTimer=delay=>{
    const timer=[...timers.values()].find(timer=>timer.delay===delay);assert(timer,'Expected host timer '+delay);
    timers.delete(timer);timer.callback();
  };
  let core,host,call,bridgeClosed=false,trust=true,failServe=false;
  class FakeCli extends EventEmitter {
    async start(){return this;}
    dispose(){}
    respond(id,result){this.response={id,result};}
    async request(method,p={}){
      calls.push(method);
      if(method==='account/read')return {account:{type:'chatgpt',email:'synthetic@example.test',planType:'plus'}};
      if(method==='account/rateLimits/read')return {rateLimits:{primary:{usedPercent:10,windowDurationMins:300,resetsAt:Date.now()/1000+3600}}};
      if(method==='model/list')return {data:[{model:'synthetic-model',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};
      if(method==='config/read')return {config:{model:'synthetic-model',model_reasoning_effort:'medium'}};
      if(method==='thread/start')return {thread:{id:'synthetic-chat',cwd:p.cwd},model:'synthetic-model',reasoningEffort:'medium'};
      if(method==='thread/resume')return {thread:{id:p.threadId,cwd:root},model:'synthetic-model',reasoningEffort:'medium'};
      if(method==='thread/turns/list')return {data:[{id:'synthetic-turn',status:'completed'}]};
      if(method==='thread/items/list')return {data:[...core.sessions.values()].find(s=>s.id===p.threadId)?.items || []};
      if(method==='turn/start')return {turn:{id:'synthetic-turn'}};
      return {};
    }
  }
  try{
    core=createSessionCore({paths:{storage:root},
      workspaceState:{get:(key,fallback)=>values.get(key)??fallback,update:async(key,value)=>{values.set(key,value);}},
      settings:(_key,fallback)=>fallback,trusted:()=>trust,logger:noop,
      events:{changed:noop,sessionChanged:noop,treeChanged:noop,notify:noop,completed:noop},
      hasChat:s=>visible.has(s.key),isActive:()=>false,activeSession:()=>null,
      openChat:noop,loadSelected:noop,defaultDirectory:()=>root,editorSelection:()=>null,
      activateConnectionOwner:noop,resolveCli:async()=>path.join(root,'synthetic-cli.exe'),
      checkCliUpdates:noop,cliCheckPending:()=>true,acceptCli:noop,clearProjectFiles:noop,
      applyPendingMode:async()=>{},taskSessions:()=>host?.tasks,createTransport:FakeCli});
    core.connections.register('synthetic.companion',{id:'synthetic-pool',label:'Synthetic pool',authenticate:async()=>{},configure:async()=> 'activate'});
    core.connections.select('synthetic-pool');
    const transport={
      privateDirectory(directory){fs.mkdirSync(directory,{recursive:true});},
      installLauncher(directory,version){assert.equal(version,'synthetic-version');return path.join(directory,'bin','mcp-server.cjs');},
      async serve(options){
        if(failServe)throw Error('Synthetic serve failure');
        call=options.call;bridgeClosed=false;
        return {descriptor:path.join(options.directory,'bridge.json'),dispose(){bridgeClosed=true;}};
      },
    };
    host=createMcpHost({core,storageRoot:root,version:'synthetic-version',transport,trusted:()=>trust,clock,settings:key=>settings.get(key),
      ui:{enabled:async enabled=>{uiEvents.push(['enabled',enabled]);},changed:()=>uiEvents.push(['changed']),
        reloadWindow:()=>{reloads++;},closeSavedTab:async key=>{savedTabKey=key;return true;},
        openChat(saved){const s=core.createSession({key:saved.key,saved});visible.add(s.key);return s;},
        hasChat:s=>visible.has(s.key),closeTab:async s=>{await core.save(s);visible.delete(s.key);core.sessions.delete(s.key);}}});
    trust=false;await assert.rejects(host.start(),/Trust/);trust=true;
    const [descriptor,again]=await Promise.all([host.start(),host.start()]);assert.equal(descriptor,again);
    assert.deepEqual(uiEvents,[['enabled',true],['changed']]);
    assert.equal(descriptor,path.join(root,'mcp','bridge.json'));
    assert.equal(host.launcher,path.join(root,'mcp','bin','mcp-server.cjs'));
    const competing=new SessionStore(path.join(root,'sessions-v1'));
    assert.throws(()=>competing.acquire('mcp-bridge'));
    assert.equal(host.tasks.limit(),3);
    settings.set('mcpMaxParallelTasks',2);assert.equal(host.tasks.limit(),2);
    settings.set('mcpMaxParallelTasks',99);assert.equal(host.tasks.limit(),5);
    settings.delete('mcpMaxParallelTasks');
    settings.set('mcpAccessMode','manual');
    const submitted=await call('submit_task',{requestId:'synthetic-submit',description:'Synthetic task',acceptanceCriteria:'Synthetic checks',projectDirectory:root});
    assert.equal(submitted.state,'queued');assert.equal(host.tasks.tasks.get(submitted.taskId).space,undefined);
    await host.tasks.tick();await host.tasks.idle();
    assert.equal(call('get_task',{taskId:submitted.taskId}).state,'running');
    assert(calls.includes('turn/start'));
    await assert.rejects(host.stop(),/Cancel active MCP tasks/);
    const s=core.sessions.values().next().value, liveTask=host.tasks.tasks.get(submitted.taskId);
    assert.equal(liveTask.accessMode,'manual');assert.equal(s.prefs.access,'read');
    assert.deepEqual(uiEvents,[['enabled',true],['changed']],'Refused stop does not toggle UI');
    assert.throws(()=>call('reload_window',{}),{code:'task_active'});
    assert.equal(timers.size,0);
    assert.deepEqual(await call('reload_window',{force:true}),{reloading:true});
    assert.equal(reloads,0);fireTimer(300);assert.equal(reloads,1);
    // MCP dispatch must dismiss stale errors before stop, blocking answer and
    // async answer, as editor handle() did before the extraction.
    s.error='Synthetic stale stop error';await host.tasks.adapter.cancel(liveTask);
    assert.equal(s.error,null);assert.equal(s.stopRequested,true);s.stopRequested=false;
    const blocking={id:'synthetic-mcp-question',method:'item/tool/requestUserInput',params:{threadId:s.id,questions:[{id:'q',question:'Synthetic choice?'}]}};
    core.pendingRequests.set(blocking.id,blocking);
    s.error='Synthetic stale answer error';
    await host.tasks.adapter.answer(liveTask,{id:blocking.id,skip:true});assert.equal(s.error,null);
    const asyncItem={id:'synthetic-async-question',type:'agentMessage',questions:[{title:'Synthetic async choice',options:['Synthetic A','Synthetic B']}]};
    s.items.push(asyncItem);s.error='Synthetic stale async error';
    await host.tasks.adapter.answer(liveTask,{id:'async-question:'+asyncItem.id,skip:true});
    assert.equal(s.error,null);assert.equal(s.asyncQuestionReplies[asyncItem.id],'skipped');
    assert(calls.includes('turn/steer'));
    const models=await call('list_models',{});assert.equal(models.models[0].model,'synthetic-model');
    const catalog=core.state.catalog, connect=core.connect, refreshCatalog=core.refreshCatalog;
    core.state.catalog=[];core.connect=async()=>{};core.refreshCatalog=()=>new Promise(()=>{});
    try{
      const timedOut=assert.rejects(call('list_models',{}),{code:'connection_unavailable'});
      fireTimer(9000);await timedOut;assert.equal(timers.size,0);
    }finally{core.state.catalog=catalog;core.connect=connect;core.refreshCatalog=refreshCatalog;}
    core.state.server.emit('notification',{method:'item/completed',params:{threadId:s.id,turnId:s.turnId,item:{id:'synthetic-report',type:'agentMessage',text:JSON.stringify({result:'Synthetic success',changedFiles:['synthetic.cjs'],checks:['Synthetic check'],remainingIssues:[]})}}});
    const waiting=call('wait_task',{taskId:submitted.taskId,waitSeconds:2});
    core.state.server.emit('notification',{method:'turn/completed',params:{threadId:s.id,turn:{id:s.turnId,status:'completed'}}});
    await host.tasks.tick();
    const completed=await waiting;assert.equal(completed.state,'completed');assert.equal(completed.report.result,'Synthetic success');
    assert.equal(call('list_tasks',{}).tasks.length,1);
    assert.equal((await host.tasks.adapter.status(liveTask)).failed,false,'Answered task has no stale failure');
    // A stop on a finished chat must clear report errors and allow outstanding
    // async questions to keep waiting rather than become a failed terminal task.
    s.items.push({id:'synthetic-unanswered',type:'agentMessage',questions:[{title:'Synthetic pending question'}]});
    s.error='Synthetic stale terminal error';await host.tasks.adapter.cancel(liveTask);
    assert.equal(s.error,null);
    const pendingStatus=await host.tasks.adapter.status(liveTask);
    assert.equal(pendingStatus.done,false);assert.equal(pendingStatus.failed,false);assert.equal(liveTask.awaitingAsync,true);
    s.items=s.items.filter(item=>item.id!=='synthetic-unanswered');
    const originalItems=s.items;s.items=[];
    const fallback=await host.tasks.adapter.status(liveTask);
    assert.equal(fallback.failed,false);assert(!fallback.report.remainingIssues.includes('Synthetic stale terminal error'));
    s.items=originalItems;
    for(const flag of ['busy','sendingTask','compacting']){
      s[flag]=true;assert.throws(()=>call('reload_window',{}),{code:'task_active'});s[flag]=false;
    }
    assert.equal(timers.size,0);
    assert.deepEqual(await call('reload_window',{}),{reloading:true});fireTimer(300);assert.equal(reloads,2);
    assert.equal((await call('wait_tasks',{taskIds:[submitted.taskId],waitSeconds:1})).settled.length,1);
    // The extracted blocking-answer path preserves preflight validation and skip.
    s.preflight={enabled:true,phase:'preparing'};
    const question={id:'synthetic-question',method:'item/tool/requestUserInput',params:{threadId:s.id,questions:[{id:'q',header:'Synthetic',question:'Synthetic choice?'}]}};
    core.pendingRequests.set(question.id,question);
    await assert.rejects(core.answer(s,{id:question.id,answers:{}}));
    assert(core.pendingRequests.has(question.id));
    await core.answer(s,{id:question.id,skip:true});
    assert.equal(s.preflight.skipped,true);assert.equal(core.pendingRequests.has(question.id),false);
    assert.deepEqual(core.state.server.response.result,{answers:{q:{answers:[]}}});
    delete s.preflight;
    // The optional space hook is inert by default and shared by list/get/waits.
    const task=host.tasks.tasks.get(submitted.taskId);task.space='synthetic-space';host.tasks.save(task);
    assert.equal(host.tasks.spaceOf(task),'synthetic-space');
    host.tasks.taskFilter=space=>space!=='synthetic-space';
    assert.equal(call('list_tasks',{}).tasks.length,0);
    for(const name of ['get_task','wait_task','wait_tasks'])assert.throws(()=>call(name,{taskId:task.taskId,taskIds:[task.taskId]}),{code:'unknown_task'});
    host.tasks.taskFilter=()=>true;
    assert.equal((await call('close_task',{taskId:task.taskId})).chatClosed,true);
    assert(core.store.session(task.sessionKey));
    assert.equal((await call('close_task',{taskId:task.taskId})).chatClosed,true);assert.equal(savedTabKey,task.sessionKey);
    assert(fs.existsSync(path.join(root,'mcp','tasks','mcp-task-'+task.taskId+'.json')));
    trust=false;assert.throws(()=>call('list_tasks',{}),{code:'workspace_untrusted'});trust=true;
    await host.stop();assert(bridgeClosed);assert.equal(host.tasks,null);
    assert.deepEqual(uiEvents,[['enabled',true],['changed'],['enabled',false],['changed']]);
    const unlock=competing.acquire('mcp-bridge');unlock();
    failServe=true;await assert.rejects(host.start(),/Synthetic serve failure/);assert.equal(host.tasks,null);
    assert.equal(uiEvents.length,4,'Failed start does not enable UI');
    competing.acquire('mcp-bridge')();failServe=false;
    await host.start();assert.equal(call('get_task',{taskId:task.taskId}).state,'completed');
    assert.equal(host.tasks.tasks.get(task.taskId).space,'synthetic-space');
    await host.stop();assert.deepEqual(uiEvents.slice(4),[['enabled',true],['changed'],['enabled',false],['changed']]);
    host=createMcpHost({core,storageRoot:root,version:'synthetic-version',transport,trusted:()=>true,clock});
    await host.start();assert.throws(()=>call('reload_window',{}),{code:'unsupported'});
    assert.throws(()=>call('reload_window',{force:true}),{code:'unsupported'});assert.equal(timers.size,0);
    await host.stop();await core.library.queue;
    console.log('MCP host: Node-only submit/run/report/close, legacy paths/lease, trust, restart and failure cleanup passed.');
  }finally{
    host?.dispose();core?.stopAccountServer();Module._load=originalLoad;
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
