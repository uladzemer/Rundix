const {itemText} = require('./session.cjs');
const {canonical} = require('./task-directory.cjs');
const reportSchema={type:'object',properties:{result:{type:'string'},changedFiles:{type:'array',items:{type:'string'}},checks:{type:'array',items:{type:'string'}},remainingIssues:{type:'array',items:{type:'string'}}},required:['result','changedFiles','checks','remainingIssues'],additionalProperties:false};
function report(session, task) {
  const attributed=task.turnId && session.items.some(item=>item.turnId);
  const items=session.items.filter(item=>attributed?item.turnId===task.turnId:!task.baselineItems?.includes(item.id));
  const result=items.filter(i=>i.type==='agentMessage').map(itemText).join('\n').slice(-60000);
  for(const item of items.filter(i=>i.type==='agentMessage').slice().reverse()) {
    try {
      const value=JSON.parse(itemText(item));
      if(typeof value.result==='string' && ['changedFiles','checks','remainingIssues'].every(k=>Array.isArray(value[k]) && value[k].every(v=>typeof v==='string')))return {...value,source:'model_report'};
    } catch {}
  }
  return {result,changedFiles:[...new Set(items.filter(i=>i.type==='fileChange').flatMap(i=>(i.changes || []).map(c=>c.path)))],
    checks:items.filter(i=>i.type==='commandExecution').map(i=>({command:i.command,exitCode:i.exitCode??null,status:i.status})),
    remainingIssues:[...(session.error?[session.error]:[]),'Structured report unavailable; review the result and command evidence.',
      ...(session.cursor?['Transcript evidence is incomplete: older session items were not loaded; commands and file changes may be missing.']:[])],source:'transcript_evidence'};
}
// MCP chats may start in these modes; plan mode needs an interactive discussion and is never used.
const taskModes={manual:'read',workspace:'workspace',auto:'workspace',full:'full'};
function taskTitle(description) {
  const line=String(description || '').split(/\r?\n/).map(text=>text.trim()).find(Boolean) || '';
  const short=line.length>60?line.slice(0,59).trimEnd()+'…':line;
  return short?'MCP · '+short:'MCP task';
}
function executor({connections,sessions,store,create,send,resume,handle,pending,save,alive,accessMode=()=>'workspace',retainTurn=()=>{},sent=()=>{}}) {
  function session(task) {
    const existing=sessions.get(task.sessionKey);
    if(existing)return existing;
    const saved=store.session(task.sessionKey);
    if(task.chatId && saved?.id!==task.chatId)throw Error('Task chat metadata is unavailable.');
    if(saved)return create(saved);
    // The mode is chosen once, when the chat is created; later changes in the chat itself are respected.
    const mode=Object.hasOwn(taskModes,accessMode())?accessMode():'workspace';
    task.accessMode=mode;
    return create({key:task.sessionKey,cwd:task.projectDirectory,model:task.model,effort:task.effort,
      prefs:{mode,access:taskModes[mode],ide:false,plan:false},name:taskTitle(task.description),customName:true});
  }
  const adapter={
    connection:()=>{const c=connections.selection();return {id:c.id,owner:c.owner,revision:c.revision};},
    assertConnection(task) {
      const selected=connections.selection();
      if(selected.id==='local')throw Error('Select an installed companion connection before submitting MCP tasks.');
      if(task && (task.connection.id!==selected.id || task.connection.owner!==selected.owner || task.connection.revision!==selected.revision))throw Error('The task belongs to a different connection selection. Restore that connection before continuing.');
    },
    chatId:task=>sessions.get(task.sessionKey)?.id || task.chatId,
    pending:task=>{const id=sessions.get(task.sessionKey)?.id || task.chatId;return id?[...pending.values()].filter(r=>r.params?.threadId===id).map(r=>({id:r.id,method:r.method,params:r.params})):[];},
    async start(task,input,checkpoint=()=>{}) {
      adapter.assertConnection(task);
      const s=session(task);
      if(canonical(s.cwd)!==task.projectDirectory)throw Error('Chat project directory changed.');
      if(s.id && !s.loaded)await resume(s,s.id);
      if(canonical(s.cwd)!==task.projectDirectory)throw Error('Chat project directory changed.');
      task.baselineItems=s.items.map(item=>item.id);
      delete task.turnId;
      checkpoint();
      s.draft=input;await save(s);
      if(task.cancelRequested){task.awaitingPreparation=true;throw Error('Cancelled before sending.');}
      const options={includeIde:false,taskId:task.taskId,projectDirectory:task.projectDirectory,requiredConnection:task.connection,outputSchema:reportSchema,
        ...(task.model?{modelSelection:{model:task.model,effort:task.effort,fast:false}}:task.effort?{modelSelection:{effort:task.effort}}:{})};
      const sendTurn=async()=>{
        const result=await send(s,input,[],options);
        if(result?.turnId){task.turnId=result.turnId;checkpoint();}
        return result;
      };
      let result=await sendTurn();
      if(task.cancelRequested && !result?.waitUntil)await handle(s,{action:'stop'});
      while(result?.waitUntil) {
        task.awaitingPreparation=true;task.progress='Waiting for companion quota reset';checkpoint();
        const c=result.connection;
        const retry=await c.provider.waitForReset(result.waitUntil,()=>alive() && !task.cancelRequested);
        connections.assertCurrent(c);
        if(!retry || task.cancelRequested)throw Error('Waiting cancelled.');
        adapter.assertConnection(task);
        task.awaitingPreparation=false;checkpoint();
        result=await sendTurn();
        if(task.cancelRequested && !result?.waitUntil)await handle(s,{action:'stop'});
      }
      if(s.draft===input)s.draft='';
      await save(s);
      await sent(s,input);
    },
    async status(task) {
      adapter.assertConnection(task);
      const s=session(task);
      if(task.needsReconcile && s.id)s.loaded=false;
      if(s.id && !s.loaded)await resume(s,s.id);
      if(canonical(s.cwd)!==task.projectDirectory)throw Error('Chat project directory changed.');
      task.needsReconcile=false;
      if(s.busy)retainTurn(s,task);
      if(s.sendingTask)return {done:false,chatId:s.id,progress:'Preparing task'};
      if(!s.id)return {done:true,failed:true,cancelled:!!task.cancelRequested,report:report(s,task)};
      return {chatId:s.id,done:!s.busy,cancelled:s.lastTurnStatus==='interrupted',failed:!!s.error || s.lastTurnStatus!=='completed',pending:adapter.pending(task).length>0,
        progress:s.busy?'Codex turn active':'Turn finished',report:!s.busy?report(s,task):null};
    },
    async answer(task,approval) {
      adapter.assertConnection(task);
      const s=session(task);
      const request=adapter.pending(task).find(r=>String(r.id)===String(approval.id));
      if(!request)throw Error('Approval is no longer pending.');
      if(approval.decision==='acceptForSession')throw Error('MCP approvals must be scoped to this request.');
      await handle(s,{...approval,action:'answer'});
      if(adapter.pending(task).some(r=>String(r.id)===String(approval.id)))throw Error('Approval response was rejected.');
    },
    async cancel(task) {
      adapter.assertConnection(task);
      const s=session(task);
      if(task.needsReconcile && s.id)s.loaded=false;
      if(s.id && !s.loaded)await resume(s,s.id);
      task.needsReconcile=false;
      if(s.busy)retainTurn(s,task);
      await handle(s,{action:'stop'});
      // Do not label the task cancelled before turn/completed confirms interruption.
    },
  };
  return adapter;
}
module.exports={executor,reportSchema,report,taskTitle};
