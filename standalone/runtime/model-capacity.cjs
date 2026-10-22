// Only a confirmed failed turn may trigger a new continuation. Never replay input.
const {identity}=require('./account.cjs');
const DELAYS=[60000,120000,300000];
const CONTINUE='Continue the task from where you stopped.';
function atCapacity(error) {
  // Prefer protocol data over display text, which can change or be localized.
  if(error?.codexErrorInfo!=null && error.codexErrorInfo!=='other')return error.codexErrorInfo==='serverOverloaded';
  return typeof error?.message==='string' && /\bselected model is at capacity\b/i.test(error.message);
}
function createCapacityRecovery(deps) {
  const records=new Map();
  function cancel(s) {
    const row=records.get(s);
    if(row?.timer!==undefined)deps.clearTimeout(row.timer);
    if(row)row.cancelled=true;
    s.capacityRetry=null;
  }
  function clear() { for(const s of records.keys())cancel(s);records.clear(); }
  function assertCurrent(s,row) {
    if(records.get(s)!==row || row.cancelled || deps.disposed || deps.authBusy ||
      deps.sessions.get(s.key)!==s || s.id!==row.threadId || deps.server!==row.server ||
      deps.activeConnection!==row.connection || identity(deps.account)!==row.account ||
      deps.limitsEpoch!==row.epoch || s.model!==row.model || s.effort!==row.effort ||
      s.cwd!==row.cwd || s.prefs.access!==row.access || s.prefs.plan!==row.plan ||
      s.prefs.fast!==row.fast || s.stopRequested || s.mcpTask || s.preflight?.enabled ||
      (s.lastStartedTurnId || null)!==row.turnId)
      throw Object.assign(Error(deps.locale.t('Автопродолжение отменено: состояние сессии изменилось.')),{notSent:true,deliveryUncertain:false});
  }
  function beforeSend(s,options) {
    if(options.capacityRecovery)assertCurrent(s,options.capacityRecovery);
    else {cancel(s);records.delete(s);}
  }
  function completed(s,message) {
    const turn=message.params?.turn;
    if(message.method!=='turn/completed' || !turn?.id)return;
    if(turn.status!=='failed' || !atCapacity(turn.error)) { cancel(s);records.delete(s);return; }
    // MCP executors own their task state; preparation requires its own approval lifecycle.
    if(deps.serviceMode || s.mcpTask || s.preflight?.enabled || s.stopRequested || !deps.hasChat(s))return;
    let row=records.get(s);
    if(row?.turnId===turn.id)return; // Duplicate terminal notification.
    const attempt=row && !row.cancelled?row.attempt+1:0;
    cancel(s);
    row={attempt,turnId:turn.id,threadId:s.id,server:deps.server,connection:deps.activeConnection,
      account:identity(deps.account),epoch:deps.limitsEpoch,model:s.model,effort:s.effort,fast:s.prefs.fast,
      cwd:s.cwd,access:s.prefs.access,plan:s.prefs.plan};
    records.set(s,row);
    if(attempt>=DELAYS.length)return;
    s.capacityRetry={attempt:attempt+1,delaySeconds:DELAYS[attempt]/1000};
    row.timer=deps.setTimeout(async()=>{
      row.timer=undefined;
      try {
        assertCurrent(s,row);
        if(s.busy || s.compacting || s.sendingTask || !deps.hasChat(s))throw Error(deps.locale.t('Автопродолжение отменено: состояние сессии изменилось.'));
        s.capacityRetry=null;
        const result=await deps.send(s,CONTINUE,[],{capacityRecovery:row,consumeDraft:false,includeIde:false});
        if(result?.waitUntil)throw Error(deps.locale.t('Автопродолжение ожидает доступности соединения. Продолжите вручную.'));
        await deps.save(s);
      } catch(error) {
        // No second attempt after a failed/ambiguous start or changed ownership.
        if(records.get(s)===row && !row.cancelled) {
          cancel(s);
          if(deps.sessions.get(s.key)===s && deps.server===row.server && s.id===row.threadId &&
            identity(deps.account)===row.account && deps.limitsEpoch===row.epoch)s.error=error.message;
        }
      } finally {deps.publish(s);}
    },DELAYS[attempt]);
    row.timer?.unref?.();
  }
  function stop(s) { const row=records.get(s);if(row)row.cancelledByUser=true;cancel(s);deps.publish(s); }
  return {beforeSend,completed,cancel:stop,clear};
}
module.exports={atCapacity,createCapacityRecovery,DELAYS,CONTINUE};
