// Service-only observation: metadata and one turn, never full rollout hydration.
const {usageLimit}=require('./task-recovery.cjs');
const {readItem}=require('./session.cjs');
const STATUS_TIMEOUT_MS=30000, MISSING_EVENTS_MS=120000;
function createTaskStatus({core,provider,now=Date.now,status,finishRun,runs}) {
  return async task=>{
    let session=core.sessions.get(task.sessionKey);
    const saved=session || core.store.session(task.sessionKey);
    if(!task.chatId && !saved?.id && task.deliveryPhase!=='dispatching')
      return {done:true,failed:true,notSent:true,cancelled:!!task.cancelRequested,progress:'Execution did not start'};
    if(!session && saved)session=core.createSession({key:task.sessionKey,saved});
    const generation=provider.cli?.binding?.appServerGeneration;
    const changed=session && session.cliGeneration!==generation;
    const missingEvents=session?.busy && now()-Math.max(task.lastActivityAt || 0,task.lastStatusReadAt || 0)>=MISSING_EVENTS_MS;
    if(session?.id && (task.needsReconcile || changed || !session.loaded || missingEvents)) {
      await core.connect();
      const server=core.state.server,owner=provider.cli?.binding?.appServerGeneration;
      const current=()=>core.state.server===server && provider.cli?.binding?.appServerGeneration===owner;
      let thread;
      if(changed || !session.loaded) {
        const result=await server.request('thread/resume',await core.resumeOptions(session,session.id),STATUS_TIMEOUT_MS);
        thread=result.thread;
      } else {
        const result=await server.request('thread/read',{threadId:session.id,includeTurns:false},STATUS_TIMEOUT_MS);
        thread=result.thread;
      }
      const turns=await server.request('thread/turns/list',{threadId:session.id,limit:1,sortDirection:'desc',itemsView:'summary'},STATUS_TIMEOUT_MS);
      if(!current())throw Object.assign(Error('Status binding changed.'),{code:'stale_instance'});
      const last=turns.data?.[0],busy=thread?.status?.type==='active';
      if(!busy) {
        // Reports are needed once at terminal reconciliation, not while tools run.
        const page=await server.request('thread/items/list',{threadId:session.id,limit:20,sortDirection:'desc'},STATUS_TIMEOUT_MS);
        if(!current())throw Object.assign(Error('Status binding changed.'),{code:'stale_instance'});
        const items=new Map(session.items.map(item=>[item.id,item]));
        for(const entry of (page.data || []).slice().reverse())items.set(entry.id,readItem(entry));
        session.items=[...items.values()].slice(-200);
      }
      session.loaded=true;session.cliGeneration=owner;session.busy=busy;
      session.turnId=busy?last?.id:null;session.lastReadTurnId=last?.id;
      if(last?.id)session.lastStartedTurnId=last.id;
      session.lastTurnStatus=!busy && last?.status==='inProgress'?'interrupted':last?.status;
      session.error=busy?null:last?.error?.message || null;
      if(last && usageLimit(last.error))task.exhaustedTurnId=last.id;
      else if(!busy && last?.status==='completed')delete task.exhaustedTurnId;
      task.lastStatusReadAt=now();task.needsReconcile=false;
      await core.save(session);
    }
    const value=await status(task),row=runs.get(value.chatId);
    if(value.done && row && value.finishedTurnId)finishRun(row,value.finishedTurnId,true);
    if(value.done && task.exhaustedTurnId && (!task.turnId || task.turnId===task.exhaustedTurnId))
      return {...value,exhaustedTurnId:task.exhaustedTurnId};
    return task.providerFailureCode?{...value,failed:true,answerUnknown:!value.done,
      error:'action_required: Open companion connection settings and reconnect.',progress:'Provider action required'}:value;
  };
}
module.exports={createTaskStatus,STATUS_TIMEOUT_MS,MISSING_EVENTS_MS};
