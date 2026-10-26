// A confirmed usage-limit failure may continue the same thread only through a
// companion that can change accounts. Input is never replayed; the companion
// picks the account during its normal prepareTurn.
const {identity}=require('./account.cjs');
const {CONTINUE}=require('./model-capacity.cjs');
const {usageLimit}=require('./task-recovery.cjs');
const DELAY_MS=5000, BLOCKED_RETRY_MS=5000, MAX_RETRY_MS=60000, MAX_BLOCKED_MS=3600000, MAX_CONTINUATIONS=2, EVIDENCE_MS=1800000;
function createLimitRecovery(deps) {
  const records=new Map(), streaks=new WeakMap();
  // The account whose turn ended by limit, reported once to the next preparation.
  let evidence=null;
  const connectionId=()=>deps.activeConnection?.id || null, now=()=>(deps.Date || Date).now();
  function cancel(s) {
    const row=records.get(s);
    if(row?.timer!==undefined)deps.clearTimeout(row.timer);
    if(row)row.cancelled=true;
    records.delete(s);s.limitRetry=null;
  }
  function assertCurrent(s,row) {
    // Server, account and limits are expected to change: that is the companion's job.
    if(records.get(s)!==row || row.cancelled || deps.disposed || deps.sessions.get(s.key)!==s ||
      s.id!==row.threadId || connectionId()!==row.connection || s.model!==row.model || s.effort!==row.effort ||
      s.cwd!==row.cwd || s.prefs.access!==row.access || s.prefs.plan!==row.plan || s.prefs.fast!==row.fast ||
      s.stopRequested || s.mcpTask || s.preflight?.enabled || (s.lastStartedTurnId || null)!==row.turnId)
      throw Object.assign(Error(deps.locale.t('Автопродолжение отменено: состояние сессии изменилось.')),{notSent:true,deliveryUncertain:false});
  }
  function beforeSend(s,options) {
    if(options.limitRecovery)return assertCurrent(s,options.limitRecovery);
    // Only the client's own input resets the budget; automatic capacity retries do not.
    if(options.capacityRecovery)return;
    // The client's own input handles the limited turn and restarts the budget.
    cancel(s);streaks.delete(s);
  }
  function takeEvidence(connection) {
    const value=evidence;evidence=null;
    // Pool accounts may share a visible identity: any CLI replacement (such as a menu
    // account change) or a later successful turn invalidates the attribution.
    return !!value && value.server===deps.server && value.connection===(connection?.id || null) &&
      value.account===identity(deps.account) && now()-value.at<EVIDENCE_MS;
  }
  function completed(s,message) {
    const turn=message.params?.turn;
    if(message.method!=='turn/completed' || !turn?.id)return;
    if(turn.status!=='failed' || !usageLimit(turn.error)) {
      cancel(s);
      if(turn.status==='completed'){
        streaks.delete(s);
        // Only a later success on the same CLI disproves the exhausted account.
        if(evidence?.server===deps.server && (s.turnStartedAt || 0)>evidence.at)evidence=null;
      }
      return;
    }
    if(deps.account)evidence={server:deps.server,connection:connectionId(),account:identity(deps.account),at:now()};
    const provider=deps.activeConnection?.provider;
    if(deps.serviceMode || s.mcpTask || s.preflight?.enabled || s.stopRequested || !deps.hasChat(s) ||
      typeof provider?.prepareTurn!=='function')return;
    // A companion failure here must not skip the host's own completion bookkeeping.
    try{if(provider.recoversUsageLimit?.()!==true)return;}catch{return;}
    if(records.get(s)?.turnId===turn.id)return; // Duplicate terminal notification.
    cancel(s);
    const attempt=(streaks.get(s) || 0)+1;
    if(attempt>MAX_CONTINUATIONS)return;
    streaks.set(s,attempt);
    const row={attempt,turnId:turn.id,threadId:s.id,connection:connectionId(),model:s.model,effort:s.effort,
      fast:s.prefs.fast,cwd:s.cwd,access:s.prefs.access,plan:s.prefs.plan,blockedSince:null};
    records.set(s,row);
    s.limitRetry={attempt,max:MAX_CONTINUATIONS,delaySeconds:DELAY_MS/1000};
    // A running task elsewhere only refuses an account change (retryable below); after another
    // continuation already switched, this one must not wait for that whole task.
    const blocked=()=>deps.authBusy || s.busy || [...deps.sessions.values()].some(other=>other.compacting || other.sendingTask);
    const run=async()=>{
      row.timer=undefined;
      try {
        assertCurrent(s,row);
        if(!deps.hasChat(s))throw Error(deps.locale.t('Автопродолжение отменено: состояние сессии изменилось.'));
        // Parallel limited tasks continue one at a time, so only one of them switches accounts.
        if(blocked()) {
          row.blockedSince ??= now();
          if(now()-row.blockedSince<MAX_BLOCKED_MS) {row.timer=deps.setTimeout(run,BLOCKED_RETRY_MS);row.timer?.unref?.();return;}
          throw Error(deps.locale.t('Автопродолжение отменено: другие задачи не завершились. Продолжите вручную.'));
        }
        // Keep the cancel control visible while the companion switches or waits.
        s.limitRetry={attempt,max:MAX_CONTINUATIONS,delaySeconds:0};deps.publish(s);
        const options={limitRecovery:row,consumeDraft:false,includeIde:false};
        let result=await deps.send(s,CONTINUE,[],options);
        while(result?.waitUntil) {
          const connection=result.connection;
          const proceed=await connection.provider.waitForReset(result.waitUntil,()=>{
            try{deps.connections.assertCurrent(connection);assertCurrent(s,row);return deps.hasChat(s);}catch{return false;}
          });
          if(!proceed)throw Error(deps.locale.t('Ожидание отменено. Черновик сохранён.'));
          result=await deps.send(s,CONTINUE,[],options);
        }
        if(records.get(s)===row){records.delete(s);s.limitRetry=null;}
        await deps.save(s);
      } catch(error) {
        if(error?.retryable && records.get(s)===row && !row.cancelled) {
          // Nothing was sent; another window or task still holds the connection.
          row.blockedSince ??= now();
          if(now()-row.blockedSince<MAX_BLOCKED_MS) {
            // Each refusal repeats the full preparation, so back off while a long task runs.
            row.retryMs=Math.min(MAX_RETRY_MS,(row.retryMs || BLOCKED_RETRY_MS/2)*2);
            s.limitRetry={attempt,max:MAX_CONTINUATIONS,delaySeconds:row.retryMs/1000};
            row.timer=deps.setTimeout(run,row.retryMs);row.timer?.unref?.();return;
          }
        }
        // No second attempt after a failed/ambiguous start or changed ownership.
        if(records.get(s)===row && !row.cancelled) {
          cancel(s);
          if(deps.sessions.get(s.key)===s && s.id===row.threadId)s.error=error.message;
        }
      } finally {deps.publish(s);}
    };
    row.timer=deps.setTimeout(run,DELAY_MS);
    row.timer?.unref?.();
  }
  function stop(s) { cancel(s);deps.publish(s); }
  return {beforeSend,completed,takeEvidence,cancel:stop};
}
module.exports={createLimitRecovery,DELAY_MS,MAX_CONTINUATIONS};
