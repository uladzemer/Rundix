const {randomUUID}=require('node:crypto');
const MAX_ENTRIES=50,MAX_BYTES=2*1024*1024;
const inFlight=new WeakMap();
function prune(task) {
  const rows=task.unsentInputs || [];
  const protectedId=task.inputAttempt?.id || rows.findLast(row=>row.possiblyNotDelivered)?.id;
  let bytes=Buffer.byteLength(JSON.stringify(rows));
  while(rows.length>MAX_ENTRIES || bytes>MAX_BYTES){
    const oldest=rows.findIndex(row=>row.id!==protectedId);
    if(oldest<0)break;
    rows.splice(oldest,1);bytes=Buffer.byteLength(JSON.stringify(rows));
  }
}
function remember(task,text) {
  task.unsentInputs ||= [];
  let id;
  if(!task.unsentInputs.some(row=>!row.possiblyNotDelivered && row.text===text)){
    id=randomUUID();task.unsentInputs.push({id,text});
  }
  prune(task);
  return id;
}
function delivered(task,text) {
  if(task.unsentInputs)task.unsentInputs=task.unsentInputs.filter(row=>row.possiblyNotDelivered || row.text!==text);
}
function begin(task,{id,text,threadId,previousTurnId}) {
  task.inputAttempt={id,threadId,previousTurnId};
  const rows=(task.unsentInputs || []).filter(row=>row.id!==task.queuedInputRecoveryId || row.text!==text);
  delete task.queuedInputRecoveryId;
  task.unsentInputs=[...rows,{id,text,attempt:{threadId},possiblyNotDelivered:true}];
  inFlight.set(task,id);
  prune(task);
}
function expose(task,id) {
  return inFlight.get(task)===id && inFlight.delete(task);
}
function observedTurn(task,id,turnId) {
  const row=task.unsentInputs?.find(row=>row.id===id && row.possiblyNotDelivered);
  if(!row || row.attempt.turnId || !turnId)return false;
  row.attempt.turnId=turnId;
  return true;
}
function takeAttempt(task,id,keepQueued=false) {
  if(!id)return null;
  const row=task.unsentInputs?.find(row=>row.id===id && row.possiblyNotDelivered);
  if(!row)return null;
  const index=task.unsentInputs.indexOf(row);
  task.unsentInputs=task.unsentInputs.filter(item=>item!==row);
  expose(task,id);
  if(task.inputAttempt?.id===id){
    delete task.inputAttempt;
    if(!keepQueued && !task.queuedRecoveryInput && task.nextInput===row.text)delete task.nextInput;
  }
  return {row,index};
}
function requeue(task,id) {
  const row=task.unsentInputs?.find(row=>row.id===id && row.possiblyNotDelivered);
  if(!row)return false;
  return task.nextInput===row.text ? !!takeAttempt(task,id,true) : settle(task,id,true);
}
function settle(task,id,unsent=false) {
  const attempt=takeAttempt(task,id);
  if(!attempt)return false;
  const {row,index}=attempt;
  if(!unsent)delivered(task,row.text);
  else if(!task.unsentInputs.some(item=>!item.possiblyNotDelivered && item.text===row.text))
    task.unsentInputs.splice(index,0,{id,text:row.text});
  return true;
}
function confirm(task,id) {
  const ownsDispatch=task.inputAttempt?.id===id && task.deliveryPhase==='dispatching';
  if(!settle(task,id))return false;
  if(ownsDispatch)task.deliveryPhase='confirmed';
  return true;
}
function matchingMessage(task,id,session,turnId,baseline=task.baselineItems) {
  const row=task.unsentInputs?.find(row=>row.id===id && row.possiblyNotDelivered);
  return !!(row && row.attempt?.threadId===session?.id && turnId && baseline && session?.items?.some(item=>item.type==='userMessage' &&
    item.turnId===turnId && !baseline.includes(item.id) && item.content?.length===1 &&
    item.content[0]?.type==='text' && item.content[0].text===row.text));
}
function visible(task) {
  const hidden=inFlight.get(task);
  return (task.unsentInputs || []).filter(row=>row.id!==hidden);
}
function counts(task,rows=visible(task)) {
  const possiblyNotDeliveredCount=rows.filter(row=>row.possiblyNotDelivered).length;
  return {unsentInputCount:rows.length,...(possiblyNotDeliveredCount?{possiblyNotDeliveredCount}:{})};
}
function page(task,after) {
  const rows=visible(task),start=after?rows.findIndex(row=>row.id===after)+1:0;
  const selected=[];let bytes=0;
  for(const {id,text,possiblyNotDelivered} of rows.slice(start)){
    const row={id,text,...(possiblyNotDelivered?{possiblyNotDelivered:true}:{})};
    const size=Buffer.byteLength(JSON.stringify(row));
    if(selected.length && (selected.length>=10 || bytes+size>512000))break;
    selected.push(row);bytes+=size;
  }
  return {unsentInputs:selected,...counts(task,rows),
    nextUnsentCursor:start+selected.length<rows.length?selected.at(-1).id:null};
}
module.exports={remember,delivered,begin,expose,requeue,settle,confirm,observedTurn,matchingMessage,visible,counts,page,prune,MAX_ENTRIES,MAX_BYTES};
