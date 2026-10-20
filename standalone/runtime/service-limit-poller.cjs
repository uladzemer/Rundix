// One poller per service/provider, independent of task count and waiters.
const {randomUUID} = require('node:crypto');
const {providerWait} = require('./service-headless-host.cjs');
function createLimitPoller({host, pollMs = 15000, now = Date.now}) {
  let inFlight = false, closed = false, backoff = 60000;
  const waiting = () => [...host.mcp.tasks.tasks.values()].filter(task => task.state === 'waiting_limit' && !task.cancelRequested);
  async function tick() {
    if (closed) return;
    const tasks = waiting();
    if (closed || inFlight || !tasks.length) return;
    const due = tasks.find(task => now() >= Math.max(task.nextCheckAt || 0, task.waitingLimit?.resetAt || 0));
    if (!due) return;
    inFlight = true;
    try {
      await host.core.connect();
      const result = await host.provider.prepareTurn({taskId:due.taskId, spaceId:due.space,
        attemptId:randomUUID(), waitId:due.waitId}, {mode:'probe'});
      if (closed) return;
      if (result.kind === 'ready') {
        backoff = 60000;
        for (const task of waiting()) {
          task.state = 'queued'; task.waitingLimit = null; task.progress = 'Provider availability confirmed; admission queued';
          host.mcp.tasks.save(task);
        }
        host.mcp.tasks.schedule();
      } else if (result.kind !== 'cancelled') {
        const wait = providerWait(result);
        if (!wait) throw Object.assign(Error('Provider action required.'),{code:result.code,providerOutcome:true});
        const unknown = !wait.resetAt;
        const delay = Math.max(wait.retryAfterMs || result.retryAfterMs || 0, unknown ? backoff : 0);
        const next = now() + delay;
        if (unknown) backoff = Math.min(backoff * 2, 900000); else backoff = 60000;
        for (const task of tasks.filter(task=>task.state==='waiting_limit' && !task.cancelRequested)) {
          task.retryNotBefore=now()+(wait.retryAfterMs || result.retryAfterMs || 0);
          const value = {resetAt:wait.resetAt, reason:wait.reason};
          task.nextCheckAt = next;
          if (JSON.stringify(task.waitingLimit) !== JSON.stringify(value)) {task.waitingLimit = value; host.mcp.tasks.save(task);}
          else host.mcp.tasks.store.write('mcp-task', task.taskId, task); // Scheduling metadata is durable without a visible revision bump.
        }
      }
    } catch (error) {
      if (closed) return;
      const permanent=error.providerOutcome || ['AUTH_REQUIRED','AUTH_REVOKED','STORE_UNAVAILABLE','CLIENT_REQUIRED','PLATFORM_UNSUPPORTED','MIRROR_BUSY','PROVIDER_CONFIG_INVALID','PROVIDER_NOT_CONFIGURED','PROVIDER_INCOMPATIBLE','PROVIDER_PROTOCOL_INVALID'].includes(error.code);
      if(!permanent) {
        // Transport/restart failure is not an authorization decision. Keep the
        // durable wait and input, backing off only the cohort actually probed.
        for(const task of tasks.filter(task=>task.state==='waiting_limit')) {
          task.nextCheckAt=now()+backoff;host.mcp.tasks.store.write('mcp-task',task.taskId,task);
        }
        backoff=Math.min(backoff*2,900000);return;
      }
      const affected=error.providerOutcome?tasks:[due];
      for(const task of affected.filter(task=>task.state==='waiting_limit' && !task.cancelRequested)) {
        task.state='error';task.waitingLimit=null;task.error='action_required: Open companion connection settings and reconnect.';
        task.recoveryRequired=false;host.mcp.tasks.release(task);host.mcp.tasks.save(task);
        try {await host.provider.cancelWait?.({waitId:task.waitId,taskId:task.taskId,spaceId:task.space});} catch {}
      }
    } finally {inFlight = false;}
  }
  const timer = setInterval(() => {void tick();}, pollMs); timer.unref?.();
  const wake = () => {
    // An idle wake is useful for BUSY_ACTIVE; retryAfterMs remains a lower bound.
    const waits = waiting();
    for(const task of waits.filter(task=>task.waitingLimit?.reason==='active_turns'))task.nextCheckAt=Math.max(now(),task.retryNotBefore || 0);
    void tick();
  };
  host.provider.on('idle', wake);
  return {tick, get busy() {return inFlight;}, dispose() {closed = true; clearInterval(timer); host.provider.removeListener('idle', wake);}};
}
module.exports = {createLimitPoller};
