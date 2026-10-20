// Only explicit pre-send failures or definite RPC refusals permit a new answer.
// send() marks everything thrown before turn/start as notSent; transport failures stay ambiguous.
function refused(error) {
  return error?.notSent === true || error?.retryable === true || error?.deliveryOutcome === 'rejected' || error?.deliveryUncertain === false;
}
function unknown(error) {
  return Object.assign(Error('Answer delivery could not be confirmed. Inspect the chat and reconcile its turn before answering again.'),
    {code:'delivery_unknown',deliveryOutcome:'unknown',cause:error});
}
module.exports={refused,unknown};
