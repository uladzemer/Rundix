require('./test-isolation.cjs').isolate();
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createLimitPoller} = require('../runtime/service-limit-poller.cjs');
async function main() {
  let now = 100000, calls = 0, saves = 0, schedules = 0, outcome, releaseProbe, probeError;
  const provider = new EventEmitter();
  provider.prepareTurn = async (_task, options) => {calls++; assert.equal(options.mode, 'probe'); if (releaseProbe) await new Promise(resolve => {releaseProbe = resolve;}); if(probeError)throw probeError;return outcome;};
  const tasks = new Map(Array.from({length:100}, (_, index) => ['synthetic-' + index, {taskId:'synthetic-' + index, space:'synthetic-space', waitId:'synthetic-wait-' + index,
    state:'waiting_limit', waitingLimit:{resetAt:null, reason:'limits_unknown'}, revision:1, nextCheckAt:0}]));
  const host = {provider, core:{connect:async () => {}}, mcp:{tasks:{tasks, store:{write() {}}, save(task) {saves++; task.revision++;}, schedule() {schedules++;}, release() {}}}};
  const poller = createLimitPoller({host, now:() => now, pollMs:1000000});
  try {
    outcome = {kind:'unavailable', code:'LIMITS_UNKNOWN', retryAfterMs:90000};
    releaseProbe = true; const probing = poller.tick(); await Promise.resolve(); await Promise.resolve();
    await poller.tick(); assert.equal(calls, 1); releaseProbe(); releaseProbe = null; await probing;
    assert.equal(saves, 0, 'Unchanged quota result does not bump task revisions');
    now += 60000; await poller.tick(); assert.equal(calls, 1, 'retryAfterMs is a lower bound');
    now += 30000; await poller.tick(); assert.equal(calls, 2);
    now += 119999; await poller.tick(); assert.equal(calls, 2, 'Unknown backoff doubles globally');
    now++; outcome = {kind:'ready'}; await poller.tick(); assert.equal(calls, 3);
    assert.equal(saves, 100); assert.equal(schedules, 1); assert([...tasks.values()].every(task => task.state === 'queued'));
    const one = tasks.values().next().value; one.state = 'waiting_limit'; one.waitingLimit = {resetAt:now + 100, reason:'low_remaining'};
    await poller.tick(); assert.equal(calls, 3); now += 100; await poller.tick(); assert.equal(calls, 4, 'Known reset requires a fresh probe');
    one.state = 'waiting_limit'; one.waitingLimit = {resetAt:null, reason:'active_turns'}; one.nextCheckAt = now + 500;one.retryNotBefore=now+500;
    provider.emit('idle'); await Promise.resolve(); assert.equal(calls, 4); now += 500; await poller.tick(); assert.equal(calls, 5);
    const fresh={taskId:'synthetic-new',space:'synthetic-other-space',waitId:'synthetic-new-wait',state:'waiting_limit',waitingLimit:{resetAt:null,reason:'active_turns'},nextCheckAt:now};
    tasks.set(fresh.taskId,fresh);one.state='waiting_limit';one.waitingLimit={resetAt:null,reason:'limits_unknown'};one.nextCheckAt=now;
    outcome={kind:'unavailable',code:'LIMITS_UNKNOWN',retryAfterMs:0};await poller.tick();const backed=calls;
    fresh.waitingLimit={resetAt:null,reason:'active_turns'};fresh.nextCheckAt=now;fresh.retryNotBefore=now;
    provider.emit('idle');await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,backed+1,'New active waiter/idle is not gated by old unknown backoff');
    const newcomer={...fresh,taskId:'synthetic-fresh',waitId:'synthetic-fresh-wait',nextCheckAt:now};tasks.set(newcomer.taskId,newcomer);
    probeError=Object.assign(Error('Synthetic restart'),{code:'PROVIDER_UNAVAILABLE'});await poller.tick();assert.equal(newcomer.state,'waiting_limit');assert.equal(one.state,'waiting_limit');
    let cancelled=0;provider.cancelWait=async()=>{cancelled++;};probeError=Object.assign(Error('Synthetic auth'),{code:'AUTH_REQUIRED'});newcomer.nextCheckAt=now;
    await poller.tick();assert.equal(newcomer.state,'error');assert.equal(one.state,'waiting_limit');assert.equal(cancelled,1);
    console.log('PASS shared limit poller: 100 waits/one probe, single-flight, unchanged revisions, retry lower bound, backoff, known reset and idle wake.');
  } finally {poller.dispose();}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
