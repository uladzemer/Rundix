const {AsyncLocalStorage}=require('node:async_hooks');
const scope=new AsyncLocalStorage();
const MAX_ATTEMPTS=3, BUDGET_MS=120000;
const progress='Waiting for the Codex connection to become ready';
function exhausted(){return Object.assign(Error('Open companion connection settings and reconnect.'),{
  code:'SERVICE_READINESS_EXHAUSTED',reason:'action_required',notSent:true,deliveryUncertain:false,retryable:false});}
// Only bootstrap failures known to precede model dispatch may re-enter the queue.
function startupFailure(error, phase) {
  const transient=['PROVIDER_UNAVAILABLE','PROVIDER_PROCESS_UNCERTAIN','BUSY_ACTIVE'].includes(error?.code) ||
    phase==='cli' && ['rejected','recovery_required'].includes(error?.code);
  return transient ? Object.assign(error,{notSent:true,deliveryUncertain:false,retryable:true,serviceReadiness:true}) : error;
}
function remaining(){
  const context=scope.getStore();
  if(!context?.active)return undefined;
  const ms=context.deadline-Date.now();if(ms<=0)throw exhausted();return ms;
}
// The budget proves only that bootstrap has not sent a model request. After
// dispatch it must never block acknowledgements, interrupts or reconciliation.
function dispatched(){const context=scope.getStore();if(context)context.active=false;}
// Applied only to bootstrap/authentication/non-model reads. An expired await
// never continues into dispatch; CLI/provider fencing owns late auth results.
async function ready(operation){
  const ms=remaining();if(ms===undefined)return operation();
  let timer;
  try{return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(exhausted()),ms);})]);}
  finally{clearTimeout(timer);}
}
async function attempt(task,checkpoint,operation){
  // Time in the directory/parallel queue is not a connection attempt. Starting
  // this clock at submission rejects healthy tasks after another long turn.
  const budget=task.serviceReadiness ||= {startedAt:Date.now(),attempts:0};
  delete task.readinessAfterWait;
  if(!Number.isFinite(budget.startedAt) || !Number.isInteger(budget.attempts) || budget.attempts<0 ||
    budget.attempts>=MAX_ATTEMPTS || Date.now()-budget.startedAt>=BUDGET_MS)throw exhausted();
  budget.attempts++;checkpoint();
  try{
    const context={deadline:budget.startedAt+BUDGET_MS,active:true};
    let result;
    try{result=await scope.run(context,operation);}finally{context.active=false;}
    delete task.serviceReadiness;return result;
  }catch(error){
    // Quota/active-turn waits may last hours. Start a new bootstrap budget only
    // when availability wakes the task, not when it enters that separate wait.
    if(error.providerWait){delete task.serviceReadiness;task.readinessAfterWait=true;}
    if(error.serviceReadiness){
      if(budget.attempts>=MAX_ATTEMPTS || Date.now()-budget.startedAt>=BUDGET_MS)throw exhausted();
      error.progress=progress;
    }
    throw error;
  }
}
module.exports={startupFailure,attempt,ready,remaining,dispatched,MAX_ATTEMPTS,BUDGET_MS,progress};
