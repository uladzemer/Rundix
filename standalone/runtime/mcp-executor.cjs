const {itemText} = require('./session.cjs');
const {canonical} = require('./task-directory.cjs');
const asyncQuestions = require('./async-questions.cjs');
const delivery = require('./mcp-delivery.cjs');
const composerDraft = require('./composer-draft.cjs');
const inputRecovery = require('./mcp-input-recovery.cjs');
const reportSchema={type:'object',properties:{result:{type:'string'},changedFiles:{type:'array',items:{type:'string'}},checks:{type:'array',items:{type:'string'}},remainingIssues:{type:'array',items:{type:'string'}}},required:['result','changedFiles','checks','remainingIssues'],additionalProperties:false};
function report(session, task) {
  // A task run may span several turns (for example answers to Codex questions); the report covers all of them.
  const turns=task.turnIds?.length?task.turnIds:task.turnId?[task.turnId]:[];
  const attributed=turns.length && session.items.some(item=>item.turnId);
  const items=session.items.filter(item=>attributed?turns.includes(item.turnId):!task.baselineItems?.includes(item.id));
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
// VS Code uses the panel title both for the tab label and its hover, so the title carries the
// substance of the task; the label itself is kept narrow by fixed tab sizing (see docs/mcp.md).
const TITLE_POINTS=160;
function taskTitle(description) {
  const line=String(description || '').replace(/\s+/g,' ').trim();
  // Cut by code points so an emoji is never split into a lone surrogate.
  const points=Array.from(line), short=points.length>TITLE_POINTS?points.slice(0,TITLE_POINTS-1).join('').trimEnd()+'…':line;
  return short?'MCP · '+short:'MCP task';
}
function executor({connections,sessions,store,create,send,resume,handle,pending,save,alive,client=()=>null,releases=new Map(),closeTab=async()=>{},closeSavedTab=async()=>false,models=async()=>[],reloadWindow,accessMode=()=>'workspace',retainTurn=()=>{},sent=()=>{},hasChat=s=>!!s.panel}) {
  const turnOptions=task=>({includeIde:false,taskId:task.taskId,projectDirectory:task.projectDirectory,requiredConnection:task.connection,outputSchema:reportSchema,
    ...(task.model?{modelSelection:{model:task.model,effort:task.effort,fast:false}}:task.effort?{modelSelection:{effort:task.effort}}:{})});
  // Only questions from the task's current run count; older unanswered quizzes in the chat are history.
  function asyncPending(s,task) {
    if(!s?.id || !Array.isArray(s.items))return [];
    return s.items.filter(item=>!task.baselineItems?.includes(item.id) && !task.cancelledAsyncItems?.includes(item.id) && asyncQuestions.questions(item).length && !s.asyncQuestionReplies?.[item.id] && !asyncQuestions.hasReply(s.items,item.id))
      .map(item=>({id:'async-question:'+item.id,method:'rundix/asyncQuestion',params:{threadId:s.id,
        questions:item.questions.map((question,index)=>({id:String(index),title:question.title,options:question.options || []}))}}));
  }
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
      prefs:{mode,access:taskModes[mode],ide:false,plan:false,focus:true},name:taskTitle(task.description),customName:true,mcpTask:true});
  }
  const adapter={
    connection:()=>{const c=connections.selection();return {id:c.id,owner:c.owner,revision:c.revision};},
    assertConnection(task) {
      const selected=connections.selection();
      if(selected.id==='local')throw Error('Select an installed companion connection before submitting MCP tasks.');
      if(task && (task.connection.id!==selected.id || task.connection.owner!==selected.owner || task.connection.revision!==selected.revision))throw Error('The task belongs to a different connection selection. Restore that connection before continuing.');
    },
    async ensureConnection(task) {
      adapter.assertConnection(task);
      const selected=adapter.connection();
      let timer;
      try {
        const resolved=await Promise.race([connections.resolve(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Companion availability check timed out.')),8000);})]);
        if(!resolved.provider || resolved.id!==selected.id || resolved.owner!==selected.owner || resolved.revision!==selected.revision)throw Error('The selected companion connection changed or is unavailable.');
        adapter.assertConnection(task);
        return selected;
      } finally {clearTimeout(timer);}
    },
    chatId:task=>sessions.get(task.sessionKey)?.id || task.chatId,
    models,
    reloadWindow,
    // Closes the editor tab of a finished task; the saved chat stays and a continuation reopens it.
    async closeChat(task) {
      const s=sessions.get(task.sessionKey);
      // Tabs restored after a window reload stay unloaded until shown; close those through VS Code's tab list.
      if(!s)return !!await closeSavedTab(task.sessionKey);
      if(!hasChat(s))return false;
      if(s.busy || s.sendingTask || adapter.pending(task).length)throw Error('The task chat is still active.');
      await closeTab(s);
      return true;
    },
    release(task) {
      adapter.assertConnection(task);
      const id=adapter.chatId(task);
      if(!id)return;
      if(releases.has(id))return releases.get(id);
      const matching=[...sessions.values()].filter(s=>s.id===id);
      if(matching.some(s=>s.busy || s.sendingTask || s.loading || s.compacting || s.followUpSending || s.asyncQuestionSending || s.modeChange) || adapter.pending(task).length)return;
      const server=client();
      if(!server)return;
      // Visible tabs render cached items. Keep them intact; the next use resumes before sending.
      // Mark unloaded even on failure: a timeout may have hidden a successful unsubscribe.
      for(const s of matching)s.loaded=false;
      const release=Promise.resolve().then(()=>server.request('thread/unsubscribe',{threadId:id})).finally(()=>{
        if(releases.get(id)===release)releases.delete(id);
      });
      releases.set(id,release);
      return release;
    },
    pending:task=>{
      // A closed task chat is read from its saved record instead of being reopened.
      const s=sessions.get(task.sessionKey) || (task.awaitingAsync?store.session(task.sessionKey):null),id=s?.id || task.chatId;
      return id?[...[...pending.values()].filter(r=>r.params?.threadId===id).map(r=>({id:r.id,method:r.method,params:r.params})),...asyncPending(s,task)]:[];
    },
    async start(task,input,checkpoint=()=>{}) {
      // Availability and local setup errors are definite pre-send failures.
      try {await adapter.ensureConnection(task);}catch(error){throw Object.assign(error,{notSent:true});}
      let sending=false;
      try {
      const s=session(task);
      if(canonical(s.cwd)!==task.projectDirectory)throw Error('Chat project directory changed.');
      if(s.id && !s.loaded)await resume(s,s.id);
      if(canonical(s.cwd)!==task.projectDirectory)throw Error('Chat project directory changed.');
      task.baselineItems=s.items.map(item=>item.id);
      delete task.turnId;task.turnIds=[];
      checkpoint();
      // Replace an earlier executor-owned refusal, preserving every user edit.
      composerDraft.prepare(s,input);
      await save(s);
      if(task.cancelRequested){task.awaitingPreparation=true;throw Error('Cancelled before sending.');}
      const options=turnOptions(task);
      const sendTurn=async()=>{
        sending=true;
        const draft=composerDraft.hostOwned(s)?composerDraft.snapshot(s):null;
        const result=await send(s,input,[],{...options,consumeDraft:!!draft});
        if(result?.turnId){
          task.turnId=result.turnId;task.turnIds=[...(task.turnIds || []),result.turnId];
          inputRecovery.delivered(task,input);
          const consumed=composerDraft.consume(s,draft) || result.draftConsumed===true;
          try {
            await save(s);
            await sent(s,input,{consumeDraft:consumed});
          } finally { checkpoint(); }
        }
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
      } catch(error) {if(!sending)error.notSent=true;throw error;}
    },
    async status(task) {
      adapter.assertConnection(task);
      // Waiting for the client's answer must not reopen a chat tab the user closed; answering reopens it.
      if(task.awaitingAsync && !task.unknownAnswer && !task.cancelRequested && !sessions.get(task.sessionKey)) {
        const saved=store.session(task.sessionKey);
        if(saved?.id===task.chatId && asyncPending(saved,task).length)return {done:false,pending:true,chatId:saved.id,progress:'Waiting for agent client answers'};
      }
      const s=session(task);
      if(task.needsReconcile && s.id)s.loaded=false;
      if(s.id && !s.loaded)await resume(s,s.id);
      if(canonical(s.cwd)!==task.projectDirectory)throw Error('Chat project directory changed.');
      task.needsReconcile=false;
      if(s.busy)retainTurn(s,task);
      // Let transient chat operations finish before the terminal transition's one cleanup attempt.
      if(s.sendingTask || s.modeChange || s.compacting || s.followUpSending || s.asyncQuestionSending)return {done:false,chatId:s.id,progress:'Preparing task'};
      if(!s.id)return {done:true,failed:true,cancelled:!!task.cancelRequested,report:report(s,task)};
      if(task.unknownAnswer) {
        const itemId=task.unknownAnswer.slice('async-question:'.length);
        const replied=asyncQuestions.hasReply(s.items,itemId);
        // A partial transcript cannot prove absence. While a turn is live keep the answer quarantined.
        if(replied || !s.busy && !s.cursor) {
          s.asyncQuestionReplies={...s.asyncQuestionReplies};
          if(replied)s.asyncQuestionReplies[itemId]='sent';else delete s.asyncQuestionReplies[itemId];
          await save(s);
          delete task.unknownAnswer;
        } else {task.needsReconcile=true;return {done:false,chatId:s.id,progress:'Waiting to reconcile answer delivery',answerUnknown:true};}
      }
      if(task.cancelRequested && !s.busy) {
        task.cancelledAsyncItems=[...new Set([...(task.cancelledAsyncItems || []),...asyncPending(s,task).map(r=>r.id.slice('async-question:'.length))])];
        task.awaitingAsync=false;
      }
      const hasAsync=asyncPending(s,task).length>0;
      const awaitingAsync=hasAsync && !task.cancelRequested && !s.error && (s.busy || s.lastTurnStatus==='completed');
      task.awaitingAsync=awaitingAsync && !s.busy;
      return {chatId:s.id,done:!s.busy && !awaitingAsync,cancelled:s.lastTurnStatus==='interrupted' || !!task.cancelledAsyncItems?.length && !!task.cancelRequested && !s.busy,failed:!!s.error || s.lastTurnStatus!=='completed',pending:adapter.pending(task).length>0,
        progress:awaitingAsync?'Waiting for agent client answers':s.busy?'Codex turn active':'Turn finished',report:!s.busy && !awaitingAsync?report(s,task):null};
    },
    async answer(task,approval) {
      adapter.assertConnection(task);
      const s=session(task);
      if(canonical(s.cwd)!==task.projectDirectory)throw Error('Chat project directory changed.');
      const request=adapter.pending(task).find(r=>String(r.id)===String(approval.id));
      if(!request)throw Error('Approval is no longer pending.');
      if(approval.decision==='acceptForSession')throw Error('MCP approvals must be scoped to this request.');
      if(request.method==='rundix/asyncQuestion') {
        // Validate locally before entering the host's durable delivery intent.
        asyncQuestions.buildReply(s.items.find(item=>item.id===request.id.slice('async-question:'.length)),approval.answers,{skip:approval.skip===true});
        await handle(s,{action:'answerAsync',itemId:request.id.slice('async-question:'.length),answers:approval.answers,skip:approval.skip===true,
          // Internal callback: keep new reply turns under the task's connection and directory lease.
          sendReply:async text=>{
            // Parallel starts briefly hold the connection; retry those pre-send conflicts within the client request budget.
            let result;
            for(let attempt=0;;attempt++) {
              try{adapter.assertConnection(task);}catch(error){throw Object.assign(error,{notSent:true});}
              if(task.cancelRequested)throw Object.assign(Error('Task cancelled before answering.'),{notSent:true});
              try{result=await send(s,text,[],turnOptions(task));break;}
              catch(error){if(!error?.retryable || attempt>=7)throw delivery.refused(error)?error:delivery.unknown(error);await new Promise(resolve=>setTimeout(resolve,1000));}
            }
            if(result?.turnId){task.turnId=result.turnId;task.turnIds=[...(task.turnIds || []),result.turnId];}
            if(task.cancelRequested && !result?.waitUntil)await handle(s,{action:'stop'});
            return result;
          }});
      } else await handle(s,{...approval,action:'answer'});
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
// The final structured report of an MCP turn is JSON for the client; in the chat it is shown as readable text.
function reportMarkdown(text,language) {
  let value;
  try { value=JSON.parse(text); } catch { return null; }
  if(!value || typeof value.result!=='string' || !['changedFiles','checks','remainingIssues'].every(key=>Array.isArray(value[key])))return null;
  const ru=language!=='en';
  const list=(title,items)=>items.length?'\n\n**'+title+'**\n'+items.map(item=>'- '+String(item)).join('\n'):'';
  return value.result+list(ru?'Изменённые файлы':'Changed files',value.changedFiles)+list(ru?'Проверки':'Checks',value.checks)+list(ru?'Что осталось':'Remaining issues',value.remainingIssues);
}
module.exports={executor,reportSchema,report,taskTitle,reportMarkdown};
