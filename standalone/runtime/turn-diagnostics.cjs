// Process-local aliases only. Identity/model keys are never serialized or saved.
const {atCapacity}=require('./model-capacity.cjs');
const known=new Set(['serverOverloaded','usageLimitExceeded','unauthorized','badRequest','internalServerError',
  'httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts','contextWindowExceeded','other']);
function errorCategory(error){
  const info=error?.codexErrorInfo;
  const code=typeof info==='string'?info:info && typeof info==='object'?Object.keys(info)[0]:null;
  if(known.has(code) && code!=='other')return code;
  return atCapacity(error)?'serverOverloaded':'other';
}
function safeOutcome(value){
  const number=(key,max)=>Number.isSafeInteger(value?.[key]) && value[key]>=0 && value[key]<=max?value[key]:0;
  return {attempt:number('attempt',Number.MAX_SAFE_INTEGER),account:number('account',32),model:number('model',32),
    transition:['first','unknown_account','account_changed','client_changed','same_client'].includes(value?.transition)?value.transition:'unknown_account',
    fast:value?.fast===true,status:['completed','failed','interrupted'].includes(value?.status)?value.status:'failed',
    category:known.has(value?.category)||value?.category==='none'?value.category:'other',elapsedSeconds:number('elapsedSeconds',86400)};
}
function createTurnDiagnostics({now=Date.now,write}){
  let active=new WeakMap(),previous=null,sequence=0,generation=0;
  const accounts=new Map(),models=new Map(),closed=new WeakSet();
  const alias=(map,key)=>{
    if(typeof key!=='string' || !key)return 0;
    if(map.has(key))return map.get(key);
    if(map.size>=32)return 0;
    const id=map.size+1;map.set(key,id);return id;
  };
  function finish(row,turn){
    if(row.finished || row.generation!==generation || closed.has(row.client) || turn.id!==row.turnId || !['completed','failed','interrupted'].includes(turn.status))return;
    row.finished=true;
    const elapsed=now()-row.started;
    const value={attempt:row.attempt,account:row.account,model:row.model,transition:row.transition,
      fast:row.fast,status:turn.status,category:turn.status==='failed'?turn.category:'none',
      elapsedSeconds:Number.isFinite(elapsed)?Math.max(0,Math.min(86400,Math.floor(elapsed/1000))):0};
    try{write(safeOutcome(value));}catch{/* Diagnostics never change task execution. */}
  }
  function begin(session,{client,connection,accountKey,modelKey,fast}){
    const old=active.get(session);if(old)old.finished=true;
    const account=alias(accounts,accountKey),model=alias(models,modelKey);
    const row={client,account,model,generation,fast:fast===true,started:now(),attempt:++sequence,
      previousTurn:session.lastStartedTurnId,turnId:null,finished:false,
      transition:!previous?'first':!account || !previous.account?'unknown_account':account!==previous.account?'account_changed':
        client!==previous.client || connection!==previous.connection?'client_changed':'same_client'};
    previous={account,client,connection};active.set(session,row);
    return row;
  }
  function accepted(row,turnId){
    if(!row || row.finished || row.generation!==generation || closed.has(row.client) || typeof turnId!=='string' || turnId===row.previousTurn)return;
    if(row.turnId && row.turnId!==turnId)return;
    row.turnId=turnId;
    if(row.terminal?.id===turnId)finish(row,row.terminal);
  }
  function observe(session,message,client){
    const row=active.get(session),turn=message.params?.turn;
    if(!row || row.finished || closed.has(client) || row.client!==client || message.params?.threadId!==session.id || !turn?.id || turn.id===row.previousTurn)return;
    if(message.method==='turn/completed'){
      const terminal={id:turn.id,status:turn.status,category:errorCategory(turn.error)};
      if(row.turnId)finish(row,terminal);
      else row.terminal=terminal; // Completion can precede its RPC reply; match the ID first.
    }
  }
  function disconnect(client){if(client && typeof client==='object')closed.add(client);}
  function clear(){generation++;active=new WeakMap();previous=null;accounts.clear();models.clear();sequence=0;}
  return {begin,accepted,observe,disconnect,clear};
}
module.exports={createTurnDiagnostics,errorCategory,safeOutcome};
