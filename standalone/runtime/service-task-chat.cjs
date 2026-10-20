// Service-only transcript reader. Window callers never receive a session owner.
const projection=require('./service-projection.cjs');
const failure=code=>Object.assign(Error(code),{code});
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
async function history({core,tasks,task,cursor}) {
  if(typeof cursor!=='string' || !cursor || cursor.length>8192)throw failure('invalid_argument');
  await tasks.adapter.ensureConnection(task);tasks.adapter.assertConnection(task);
  const server=core.state.server;
  const page=await server.request('thread/items/list',{threadId:task.chatId,...(cursor==='@latest'?{}:{cursor}),limit:20,sortDirection:'desc'},9000);
  tasks.adapter.assertConnection(task);
  if(core.state.server!==server)throw failure('stale_instance');
  // Twenty 16-KiB items fit the projection budget without dropping page rows.
  if(!Array.isArray(page.data) || page.data.length>20)throw failure('response_too_large');
  return {...projection.transcript(page.data.slice().reverse().map(require('./session.cjs').readItem)),cursor:page.nextCursor || null};
}
module.exports={snapshot,history};
