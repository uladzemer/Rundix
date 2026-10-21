// Fixed service continuation and bounded observation. No account selection lives here.
const CONTINUE = 'Continue the task from where you stopped.';
const MAX_READ_FAILURES = 6;
const SLOW_RETRY_MS = 300000, MIN_CONTINUATION_MS = 60000, MAX_CONTINUATIONS = 2;
function usageLimit(error) { return error?.codexErrorInfo === 'usageLimitExceeded'; }
function readFailed(task, now = Date.now()) {
  const failures = Math.min(MAX_READ_FAILURES, (task.statusRead?.failures || 0) + 1);
  task.statusRead = {failures, nextAt:now + (failures>=MAX_READ_FAILURES ? SLOW_RETRY_MS : Math.min(30000, 1000 * 2 ** (failures - 1))), slow:failures>=MAX_READ_FAILURES};
}
function canRead(task, now = Date.now()) { return !(task.statusRead?.nextAt > now); }
function slowRecovery(task) { return !!(task.statusRead?.slow || task.statusRead?.paused); }
function retryRead(task) { delete task.statusRead; }
function continueAfterLimit(task, turnId) {
  if (!turnId) return false;
  if(task.limitContinuation?.exhaustedTurnId===turnId) {
    if(task.limitContinuation.state!=='pending' || task.deliveryPhase!=='preparing')return false;
  } else task.limitContinuation = {exhaustedTurnId:turnId, state:'pending'};
  task.nextInput = CONTINUE;
  return true;
}
function continuationNotBefore(task) { return task.autoLimit?.lastSentAt == null ? 0 : task.autoLimit.lastSentAt+MIN_CONTINUATION_MS; }
function continuationBlocked(task) { return task.limitContinuation?.state==='pending' && (task.autoLimit?.consecutive || 0)>=MAX_CONTINUATIONS; }
function successfulTurn(task) { delete task.autoLimit; }
function enterLimitWait(task,now=Date.now()) {
  task.state='waiting_limit';task.recoveryRequired=false;task.needsReconcile=false;
  task.waitingLimit={resetAt:null,reason:'exhausted'};
  task.nextCheckAt=continuationBlocked(task)?now:Math.max(now,continuationNotBefore(task));task.retryNotBefore=task.nextCheckAt;
  task.error=null;task.progress='Turn ended by usage limit; waiting for provider';
  delete task.serviceReadiness;task.readinessAfterWait=true;
}
module.exports = {CONTINUE, MAX_READ_FAILURES, SLOW_RETRY_MS, MIN_CONTINUATION_MS, MAX_CONTINUATIONS,
  usageLimit, readFailed, canRead, slowRecovery, retryRead, continueAfterLimit, continuationNotBefore, continuationBlocked, successfulTurn, enterLimitWait};
