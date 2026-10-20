// Synthetic checks for the fully automated Claude ↔ Codex loop: question scoping, closed chats, multi-turn reports and slot accounting.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {executor,report,taskTitle}=require('../runtime/mcp-executor.cjs');
const {McpTasks}=require('../runtime/mcp-tasks.cjs');
const {SessionStore}=require('../runtime/store.cjs');
const {canonical}=require('../runtime/task-directory.cjs');
const quiz=id=>({id,type:'agentMessage',questions:[{title:'Synthetic choice',options:['Synthetic A','Synthetic B']}]});
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-mcp-automation-synthetic-'));
  const open=[];
  try{
    const project=canonical(root),connection={id:'synthetic-pool',owner:'synthetic',revision:1};
    const sessions=new Map(),saved=new Map();let created=0,sends=0,failures=0;
    const adapter=executor({connections:{selection:()=>connection},sessions,store:{session:key=>saved.get(key) || null},
      create:record=>{created++;const s={...record,loaded:true,busy:false};sessions.set(s.key,s);return s;},
      send:async(s)=>{if(failures>0){failures--;throw Object.assign(Error('Synthetic busy connection'),{retryable:true});}sends++;return {turnId:'synthetic-reply-turn-'+sends};},
      resume:async()=>{},handle:async(s,msg)=>{if(msg.action==='answerAsync'){await msg.sendReply('synthetic reply');s.asyncQuestionReplies={...s.asyncQuestionReplies,[msg.itemId]:'sent'};}},
      pending:new Map(),save:async()=>{},alive:()=>true});
    const s={key:'synthetic-session',id:'synthetic-chat',cwd:project,loaded:true,busy:false,lastTurnStatus:'completed',prefs:{},
      items:[quiz('synthetic-old-quiz'),{id:'synthetic-user',type:'userMessage',text:'Synthetic follow-up'},quiz('synthetic-new-quiz')]};
    sessions.set(s.key,s);
    const task={taskId:'synthetic-task',sessionKey:s.key,chatId:s.id,projectDirectory:project,connection,baselineItems:['synthetic-old-quiz','synthetic-user'],turnIds:['synthetic-turn-1']};

    // Only questions from the task's current run are pending; older quizzes are history.
    assert.deepEqual(adapter.pending(task).map(r=>r.id),['async-question:synthetic-new-quiz']);
    const waiting=await adapter.status(task);
    assert.equal(waiting.done,false);assert.equal(waiting.pending,true);assert.equal(task.awaitingAsync,true);

    // A chat closed by the user is not reopened while the client has not answered yet.
    saved.set(s.key,{...s});sessions.delete(s.key);
    const closed=await adapter.status(task);
    assert.equal(created,0,'Status must not recreate the closed chat');assert.equal(closed.pending,true);
    assert.deepEqual(adapter.pending(task).map(r=>r.id),['async-question:synthetic-new-quiz'],'Pending questions are read from the saved chat');

    // Answering reopens the chat, survives a brief connection conflict and keeps every turn in the report.
    failures=2;
    await adapter.answer(task,{id:'async-question:synthetic-new-quiz',answers:{'0':'Synthetic B'}});
    assert.equal(created,1);assert.equal(sends,1,'Retryable conflicts are retried before the reply is sent');
    assert.deepEqual(task.turnIds,['synthetic-turn-1','synthetic-reply-turn-1']);
    const reportSession={items:[
      {id:'synthetic-change-1',type:'fileChange',turnId:'synthetic-turn-1',changes:[{path:'synthetic-a.js'}]},
      {id:'synthetic-change-2',type:'fileChange',turnId:'synthetic-reply-turn-1',changes:[{path:'synthetic-b.js'}]},
      {id:'synthetic-older',type:'fileChange',turnId:'synthetic-earlier-run',changes:[{path:'synthetic-old.js'}]}]};
    assert.deepEqual(report(reportSession,task).changedFiles,['synthetic-a.js','synthetic-b.js']);

    // Titles never split a surrogate pair.
    const title=taskTitle('x'.repeat(22)+'😀'+'y'.repeat(10));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title),'No lone high surrogate');assert.match(title,/😀…$/);

    // Cancelling while a start fails before sending ends as cancelled with the directory released.
    const dir=path.join(root,'synthetic-cancel');fs.mkdirSync(dir);
    let tasks=new McpTasks({store:new SessionStore(path.join(root,'records')),maxParallel:()=>2,adapter:{connection:()=>connection,assertConnection(){},pending:()=>[],chatId:()=>null,
      async start(t){t.cancelRequested=true;throw Object.assign(Error('Synthetic busy'),{retryable:true});},async status(){return {done:false};},async cancel(){}}});open.push(tasks);
    const cancelled=tasks.call('submit_task',{requestId:'synthetic-cancel',description:'Synthetic',acceptanceCriteria:'Synthetic',projectDirectory:dir}).taskId;
    await tasks.tick();await tasks.idle();
    assert.equal(tasks.get(cancelled).state,'cancelled');
    assert.doesNotThrow(()=>require('../runtime/task-directory.cjs').acquire(tasks.directoryStore,dir,'synthetic-probe')());

    // A live recovered turn keeps its slot even while throttled or not yet reached.
    const dirs=['synthetic-r1','synthetic-r2','synthetic-r3'].map(name=>{const d=path.join(root,name);fs.mkdirSync(d);return d;});
    const starts=[];
    tasks=new McpTasks({store:new SessionStore(path.join(root,'records-recovery')),maxParallel:()=>2,adapter:{connection:()=>connection,assertConnection(){},pending:()=>[],chatId:()=>null,
      async start(t){starts.push(t.taskId);},async status(t){return {done:!t.liveTurn};},async cancel(){}}});open.push(tasks);
    const submit=(id,d)=>tasks.call('submit_task',{requestId:id,description:'Synthetic',acceptanceCriteria:'Synthetic',projectDirectory:d}).taskId;
    const first=submit('synthetic-first',dirs[0]),second=submit('synthetic-second',dirs[1]),live=submit('synthetic-live',dirs[2]);
    Object.assign(tasks.get(live),{recoveryRequired:true,liveTurn:true,liveRecovery:true});
    await tasks.tick();await tasks.idle();
    assert.deepEqual(starts,[first],'Limit 2 with one live recovered turn leaves one slot');
    assert.equal(tasks.get(second).state,'queued');
    // Finished task chats can be closed through MCP; models are listed for choosing model and effort.
    {
      const closed=[],chats=new Map();
      const closing=executor({connections:{selection:()=>connection},sessions:chats,store:{session:()=>null},create:()=>{throw Error('Unexpected create');},
        send:async()=>{},resume:async()=>{},handle:async()=>{},pending:new Map(),save:async()=>{},alive:()=>true,
        closeTab:async s=>{closed.push(s.key);s.panel=null;},models:async()=>[{model:'synthetic-model',efforts:['low','medium']}]});
      const chat={key:'synthetic-close',id:'synthetic-close-chat',panel:{},busy:false,items:[]};chats.set(chat.key,chat);
      const store=new SessionStore(path.join(root,'records-close'));
      const closer=new McpTasks({store,adapter:{...closing,connection:()=>connection,assertConnection(){},start:async()=>{},status:async()=>({done:false}),cancel:async()=>{}}});open.push(closer);
      const dir=path.join(root,'synthetic-close-dir');fs.mkdirSync(dir);
      const id=closer.call('submit_task',{requestId:'synthetic-close',description:'Synthetic',acceptanceCriteria:'Synthetic',projectDirectory:dir}).taskId;
      Object.assign(closer.get(id),{sessionKey:chat.key,state:'running'});
      await assert.rejects(()=>Promise.resolve().then(()=>closer.call('close_task',{taskId:id})),e=>e.code==='task_active');
      closer.get(id).state='completed';
      assert.deepEqual(await closer.call('close_task',{taskId:id}),{taskId:id,state:'completed',chatClosed:true});
      assert.deepEqual(closed,[chat.key]);
      assert.equal((await closer.call('close_task',{taskId:id})).chatClosed,false,'Closing again is harmless');
      chat.panel={};chat.busy=true;await assert.rejects(closer.call('close_task',{taskId:id}),e=>e.code==='task_active');
      assert.deepEqual(await closer.call('list_models'),{models:[{model:'synthetic-model',efforts:['low','medium']}]});
      // Window reload is refused while a task runs unless forced, and forwarded otherwise.
      let reloads=[];closer.adapter.reloadWindow=force=>{reloads.push(force);};
      closer.get(id).state='running';
      assert.throws(()=>closer.call('reload_window',{}),e=>e.code==='task_active');
      assert.deepEqual(await closer.call('reload_window',{force:true}),{reloading:true});
      closer.get(id).state='completed';
      assert.deepEqual(await closer.call('reload_window',{}),{reloading:true});assert.deepEqual(reloads,[true,false]);
      assert.throws(()=>closer.call('reload_window',{force:'yes'}),e=>e.code==='invalid_argument');
      // A late thread/closed does not unload a running chat.
      const {notification}=require('../runtime/session.cjs');
      const running={id:'synthetic-thread',busy:true,loaded:true,items:[]};notification(running,{method:'thread/closed',params:{threadId:'synthetic-thread'}});
      assert.equal(running.loaded,true);running.busy=false;notification(running,{method:'thread/closed',params:{threadId:'synthetic-thread'}});assert.equal(running.loaded,false);
    }
    console.log('MCP automation: run-scoped questions, closed chats stay closed, retried replies, multi-turn reports, safe titles, cancel during retryable start and recovered-turn slots passed.');
  }finally{for(const item of open)item.dispose();fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error('MCP automation synthetic checks failed:',error.message);process.exitCode=1;});
