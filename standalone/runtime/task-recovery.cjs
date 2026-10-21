// Fixed service continuation and bounded observation. No account selection lives here.
const CONTINUE = 'Continue the task from where you stopped.';
const MAX_READ_FAILURES = 6;
function usageLimit(error) { return error?.codexErrorInfo === 'usageLimitExceeded'; }
function readFailed(task, now = Date.now()) {
  const failures = Math.min(MAX_READ_FAILURES, (task.statusRead?.failures || 0) + 1);
  task.statusRead = {failures, nextAt:now + Math.min(30000, 1000 * 2 ** (failures - 1)), paused:failures >= MAX_READ_FAILURES};
}
function canRead(task, now = Date.now()) { return !task.statusRead?.paused && !(task.statusRead?.nextAt > now); }
function retryRead(task) { delete task.statusRead; }
function continueAfterLimit(task, turnId) {
  if (!turnId || task.limitContinuation?.exhaustedTurnId === turnId) return false;
  task.limitContinuation = {exhaustedTurnId:turnId, state:'pending'};
  task.nextInput = CONTINUE;
  return true;
}
module.exports = {CONTINUE, MAX_READ_FAILURES, usageLimit, readFailed, canRead, retryRead, continueAfterLimit};
