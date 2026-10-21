// Service-only transcript reader. Window callers never receive a session owner.
const projection=require('./service-projection.cjs');
const failure=code=>Object.assign(Error(code),{code});
const recovery=require('./task-recovery.cjs');
const historyReads=new WeakMap();
function snapshot({core,tasks,task,generation,revision}) {
  const session=core.sessions.get(task.sessionKey) || core.store.session(task.sessionKey);
  if(task.chatId && (!session || session.id!==task.chatId))throw failure('storage_unavailable');
  let pendingBytes=0;
  const pendingRequests=tasks.adapter.pending(task).map(request=>{
    // Never offer an answer to a question whose operation was shortened for display.
    const bytes=Buffer.byteLength(JSON.stringify(request));pendingBytes+=bytes;
    return bytes<=32768 && pendingBytes<=128*1024?request:{id:request.id,method:request.method,displayOnly:true};
  });
  const result={generation,schemaVersion:1,spaceId:task.space,taskId:task.taskId,viewRevision:revision,
    owner:'service',chatId:task.chatId || null,title:('MCP · '+task.description).slice(0,167),state:task.state,
    progress:task.progress,closed:!!task.closedAt,error:task.error || null,recoveryRequired:!!task.recoveryRequired,
    pendingRequests,...projection.transcript(session?.items || []),cursor:null};
  result.historyTruncated ||= !!session?.cursor || (session?.items.length || 0)>=200;
  // Cached/saved sessions have no durable CLI cursor. Restart normal CLI paging
  // at the latest page; item IDs let the client deduplicate cached overlap.
  if(result.historyTruncated)result.cursor='@latest';
  if(Buffer.byteLength(JSON.stringify(result))>768*1024)throw failure('response_too_large');
  return result;
}
async function history({core,tasks,task,cursor,now=Date.now}) {
  if(typeof cursor!=='string' || !cursor || cursor.length>8192)throw failure('invalid_argument');
  let records=historyReads.get(tasks);
  if(!records){records=new Map();historyReads.set(tasks,records);}
  for(const [id,row] of records)if(!row.inFlight && now()-row.touchedAt>3600000)records.delete(id);
  let observation=records.get(task.taskId);
  if(!observation || observation.epoch!==task.readRetryEpoch){
    // Archived task lookups produce a fresh object; task ID owns this budget.
    const inFlight=observation?.inFlight;
    if(inFlight)await inFlight.catch(()=>{});
    observation={epoch:task.readRetryEpoch,touchedAt:now()};records.set(task.taskId,observation);
  }
  while(observation.inFlight){
    if(observation.cursor===cursor)return observation.inFlight;
    await observation.inFlight.catch(()=>{});
  }
  const service=tasks.adapter.limitRecovery===true;
  if(service && !recovery.canRead(observation,now()))throw failure('connection_unavailable');
  observation.touchedAt=now();observation.cursor=cursor;
  const operation=(async()=>{
    let server,saved,loadedByHistory=false;
    try {
      await tasks.adapter.ensureConnection(task);tasks.adapter.assertConnection(task);
      saved=core.sessions.get(task.sessionKey) || core.store.session(task.sessionKey);
      if(!saved?.id)throw failure('storage_unavailable');
      await core.connect();server=core.state.server;
      if(!saved.loaded){
        loadedByHistory=true;
        const result=await server.request('thread/resume',await core.resumeOptions(saved,saved.id),30000);
        if(result.thread?.status?.type==='active')loadedByHistory=false;
      }
      const page=await server.request('thread/items/list',{threadId:saved.id,...(cursor==='@latest'?{}:{cursor}),limit:20,sortDirection:'desc'},30000);
      tasks.adapter.assertConnection(task);
      if(core.state.server!==server)throw failure('stale_instance');
      if(!Array.isArray(page.data) || page.data.length>20)throw failure('response_too_large');
      recovery.retryRead(observation);
      return {...projection.transcript(page.data.slice().reverse().map(require('./session.cjs').readItem)),cursor:page.nextCursor || null};
    }catch(error){
      if(service && !['response_too_large','storage_unavailable','stale_instance','invalid_argument'].includes(error.code))recovery.readFailed(observation,now());
      throw error;
    }finally{
      const live=core.sessions.get(task.sessionKey);
      if(saved && loadedByHistory && core.state.server===server && !live?.busy && !live?.sendingTask && !tasks.starting?.has(task.taskId)){
        try{await server.request('thread/unsubscribe',{threadId:saved.id},9000);}catch{}
        if(live)live.loaded=false;
      }
    }
  })();
  observation.inFlight=operation;
  try{return await operation;}finally{if(observation.inFlight===operation)delete observation.inFlight;}
}
module.exports={snapshot,history};
