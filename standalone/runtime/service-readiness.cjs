// Only bootstrap failures known to precede model dispatch may re-enter the queue.
// Each attempt retains the provider/CLI RPC deadlines; access refusals fail closed.
function startupFailure(error, phase) {
  const transient=['PROVIDER_UNAVAILABLE','PROVIDER_PROCESS_UNCERTAIN'].includes(error?.code) ||
    phase==='cli' && ['rejected','recovery_required'].includes(error?.code);
  return transient ? Object.assign(error,{notSent:true,deliveryUncertain:false,retryable:true}) : error;
}
module.exports={startupFailure};
