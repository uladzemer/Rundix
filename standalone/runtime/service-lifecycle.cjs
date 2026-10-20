'use strict';
// Integrators report tasks, queued work, provider waits, approvals, and uncertain turns as busy.
// Any connected client also prevents idle exit. No process.exit or signal handlers here.
function idleExit({clients, busy, onIdle, log = () => {}, idleMs = 300000, pollMs = 1000,
  now = Date.now, schedule = setInterval, cancel = clearInterval}) {
  let since = null, pending = false, disposed = false;
  const report = error => { try { log({code:error?.code === 'service_busy' ? 'service_busy' : 'idle_exit_failed'}); } catch {} };
  const timer = schedule(async () => {
    if (disposed || pending) return;
    let occupied;
    try { occupied = clients() > 0 || busy(); } catch (error) { report(error); occupied = true; }
    if (occupied) { since = null; return; }
    since ??= now();
    if (now() - since < idleMs) return;
    pending = true;
    try {
      const result = await onIdle();
      if (result === false || result?.exiting === false) since = null;
      else { disposed = true; cancel(timer); }
    } catch (error) { report(error); since = null; }
    finally { pending = false; }
  },pollMs);
  timer.unref?.();
  return {dispose:() => { disposed = true; cancel(timer); }};
}
module.exports = {idleExit};
