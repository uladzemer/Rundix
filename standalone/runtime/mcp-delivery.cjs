// Only explicit pre-send failures or definite RPC refusals permit a new answer.
// Transport failures (including uncoded failures) are ambiguous by default.
function refused(error) {
  return error?.notSent === true || error?.retryable === true || error?.deliveryOutcome === 'rejected';
}
function unknown(error) {
  return Object.assign(Error('Answer delivery could not be confirmed. Inspect the chat and reconcile its turn before answering again.'),
    {code:'delivery_unknown',deliveryOutcome:'unknown',cause:error});
}
// The host assigns turnStartedAt after preparation/leases and immediately before turn/start.
// Observe that assignment on the original session (no identity-changing proxy and no clock comparison).
// Any other assignment conservatively makes delivery ambiguous too. An unobservable descriptor
// falls back to unknown; this helper must never infer non-delivery after the RPC boundary.
async function send(sendTurn,session,...args) {
  const original=Object.getOwnPropertyDescriptor(session,'turnStartedAt');
  if(original && (!original.configurable || original.get || original.set || !original.writable))return sendTurn(session,...args);
  let value=session.turnStartedAt,started=false;
  const get=()=>value,set=next=>{started=true;value=next;};
  Object.defineProperty(session,'turnStartedAt',{get,set,configurable:true,enumerable:original?.enumerable ?? true});
  try {return await sendTurn(session,...args);}
  catch(error){if(!started && error?.deliveryOutcome!=='unknown' && !error?.deliveryUncertain)error.notSent=true;throw error;}
  finally {
    const current=Object.getOwnPropertyDescriptor(session,'turnStartedAt');
    if(current?.get===get && current?.set===set){
      if(original)Object.defineProperty(session,'turnStartedAt',{...original,value});
      else if(started)Object.defineProperty(session,'turnStartedAt',{value,writable:true,configurable:true,enumerable:true});
      else delete session.turnStartedAt;
    }
  }
}
module.exports={refused,unknown,send};
