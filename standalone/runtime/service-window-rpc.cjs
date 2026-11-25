// Window projections are connection-owned. Disconnect never changes task state.
const {randomUUID} = require('node:crypto');
const {fileURLToPath} = require('node:url');
const {resolveSpace, canonical} = require('./service-space.cjs');
const projection=require('./service-projection.cjs');
const failure = code => Object.assign(Error(code), {code});
const active = new Set(['queued', 'running', 'waiting_limit', 'waiting_approval']);

function windowBinding(binding) {
  // Trust must be checked before even resolving workspace metadata.
  if (binding?.trusted !== true) throw failure('workspace_untrusted');
  if (!Array.isArray(binding.workspaceFolders) || binding.workspaceFolders.length > 100 ||
      typeof binding.windowId !== 'string' || !/^[\w-]{1,128}$/.test(binding.windowId)) throw failure('invalid_argument');
  const folders = [], spaces = new Map();
  for (const uri of binding.workspaceFolders) {
    let directory;
    try {
      if (typeof uri !== 'string' || uri.length > 16384) throw failure('space_unsupported_uri');
      const url = new URL(uri);
      if (url.protocol !== 'file:' || url.search || url.hash) throw failure('space_unsupported_uri');
      directory = fileURLToPath(url);
    } catch { throw failure('space_unsupported_uri'); }
    const space = resolveSpace(directory);
    const folder = canonical(directory);
    folders.push(folder); spaces.set(space.spaceId, space);
  }
  return {bindingId:randomUUID(), windowId:binding.windowId, folders, spaces};
}

function createWindowRpc({generation, tasks,core,migration,retire}) {
  const peers = new Set(), revisions = new Map(), chatRevisions=new Map();
  migration?.onChanged((source,status)=>{for(const peer of peers)if(source===undefined || peer.windowBinding.legacyRoot===source){
    try{peer.send({method:'legacy.changed',params:{generation,status:source===undefined?migration.status(peer.windowBinding.legacyRoot):status}});}catch{peer.close();}
  }});
  const revision = spaceId => revisions.get(spaceId) || 0;
  function changed(spaceId) {
    revisions.set(spaceId, revision(spaceId) + 1);
    for (const peer of peers) if (peer.subscriptions.has(spaceId)) {
      try { peer.send({method:'space.changed', params:{generation, schemaVersion:1, spaceId, viewRevision:revision(spaceId)}}); }
      catch { peer.close(); }
    }
  }
  async function hello(params, peer) {
    const binding = windowBinding(params.binding);
    if(params.binding.legacyRoot)binding.legacyRoot=await migration?.register(params.binding.legacyRoot);
    for(const space of migration?.spaces(binding.folders) || [])binding.spaces.set(space.spaceId,space);
    if(peer.closed || peer.signal.aborted)throw failure('service_unavailable');
    peer.windowBinding = binding; peer.subscriptions = new Map();peer.chats=new Map(); peers.add(peer);
    peer.once('closed', () => {
      peers.delete(peer);
      for (const spaceId of new Set([...peer.subscriptions.keys(),...peer.chats.values()])) changed(spaceId);
      peer.subscriptions.clear();
      peer.chats.clear();
    });
    return {legacyStatus:migration?.status(binding.legacyRoot),bindingId:binding.bindingId, spaces:[...binding.spaces.values()], toolSchemaVersion:1,
      capabilities:['tasks.v1', 'limitWait.v1', 'spaceSnapshot.v1','taskChat.v1', ...(retire && binding.folders.length ? ['service.retire'] : []),
        ...(tasks().archive && binding.folders.length ? ['space.clearFinished'] : [])]};
  }
  function bound(params, peer) {
    return peer.windowBinding?.bindingId === params.bindingId && peer.windowBinding.spaces.has(params.spaceId);
  }
  function snapshot(spaceId, limit,peer,archiveView) {
    const serviceTasks = tasks();
    const order = (a,b) => Number(!!a.archived) - Number(!!b.archived) || Number(active.has(b.state)) - Number(active.has(a.state)) || b.createdAt - a.createdAt || a.taskId.localeCompare(b.taskId);
    const page = []; let totalTasks = 0;
    function include(task) {
      if (task.space !== spaceId) return;
      totalTasks++;
      if(archiveView && !task.archived)return;
      page.push(task); page.sort(order);
      if (page.length > limit) page.pop();
    }
    for (const task of serviceTasks.tasks.values()) include(task);
    // Restored/crash-duplicate active records take precedence over the archive.
    const archived=serviceTasks.archive?.page(spaceId,{limit,exclude:new Set(serviceTasks.tasks.keys())});
    for(const task of archived?.tasks || [])include(task);
    totalTasks+=(archived?.total || 0)-(archived?.tasks.length || 0);
    const legacy=migration?.visible(spaceId,peer.windowBinding.folders) || [];
    for(const row of legacy)include({...row.task,...(row.interrupted?{state:'error',recoveryRequired:true}:{}),taskId:row.taskId,space:spaceId,legacy:true,readOnly:true});
    const result = {generation, schemaVersion:1, spaceId, viewRevision:revision(spaceId),
      tasks:page.map(task => ({...(task.legacy?{taskId:task.taskId,title:String(task.description || '').slice(0,160),state:task.state,progress:task.progress,
        chatId:task.chatId || null,projectDirectory:task.projectDirectory,unsentInputCount:task.unsentInputCount || 0,pendingRequests:0,recoveryRequired:!!task.recoveryRequired}:task.archived?{taskId:task.taskId,title:task.description,state:task.state,progress:task.progress,chatId:task.chatId,projectDirectory:task.projectDirectory,createdAt:task.createdAt,updatedAt:task.updatedAt,revision:task.revision,hasReport:!!task.report,error:task.error,waitingLimit:null,unsentInputCount:task.unsentInputCount,recoveryRequired:false,pendingRequests:0}:serviceTasks.summary(task)),
        lastSelection:task.legacy?null:task.lastSelection || null,
        ...(task.archived && task.possiblyNotDeliveredCount?{possiblyNotDeliveredCount:task.possiblyNotDeliveredCount}:{}),
        readOnly:!!task.readOnly,report:task.archived || task.legacy?task.report:projection.report(task.report),closed:!!task.closedAt,archived:!!task.archived,
        actionRequired:task.providerFailureCode || (task.error?.startsWith('action_required') ? 'provider_unavailable' : null)})),
      chats:page.filter(task => task.chatId).map(task => ({taskId:task.taskId, chatId:task.chatId,
        owner:task.legacy?'legacy':'service',readOnly:!!task.readOnly,title:('MCP · ' + task.description).slice(0,167), visibility:task.closedAt ? 'closed' : 'open'})),
      windows:[...new Set([...peers].filter(peer => peer.subscriptions.has(spaceId)).map(peer => peer.windowBinding.windowId))]
        .map(windowId => ({windowId})), totalTasks, hasMoreHistory:(archiveView?archived?.total || 0:totalTasks) > page.length,
      archiveView,archivedCount:archived?.total || 0,
      clearFinishedCount:serviceTasks.archive && peer.windowBinding.spaces.get(spaceId)?.kind!=='legacy'
        ? serviceTasks.clearFinished(spaceId,{dryRun:true}).archived : 0};
    // Clip the archive page at the wire budget and indicate when more history exists.
    const budget=768*1024;
    let bytes=Buffer.byteLength(JSON.stringify(result));
    while(bytes>budget && result.tasks.at(-1)?.archived){
      const row=result.tasks.pop();bytes-=Buffer.byteLength(JSON.stringify(row))+1;
      if(row.chatId)bytes-=Buffer.byteLength(JSON.stringify(result.chats.pop()))+1;
      result.hasMoreHistory=true;
    }
    if (bytes > budget) throw failure('response_too_large');
    return result;
  }
  function chatChanged(task) {
    const viewRevision=(chatRevisions.get(task.taskId) || 0)+1;chatRevisions.set(task.taskId,viewRevision);
    for(const peer of peers)if(peer.chats.get(task.taskId)===task.space){
      try{peer.send({method:'chat.changed',params:{generation,schemaVersion:1,spaceId:task.space,taskId:task.taskId,viewRevision}});}catch{peer.close();}
    }
  }
  async function call(method, params, peer) {
    if (!bound(params, peer)) throw failure('space_not_bound');
    if(method==='space.clearFinished'){
      if(!tasks().archive || peer.windowBinding.spaces.get(params.spaceId)?.kind==='legacy')throw failure('unsupported');
      const {dryRun=false,expected}=params;
      if(typeof dryRun!=='boolean' || !dryRun && expected===undefined || expected!==undefined && (!Number.isSafeInteger(expected?.archived) || expected.archived<0 ||
        !Number.isSafeInteger(expected?.withUnsent) || expected.withUnsent<0))throw failure('invalid_argument');
      return tasks().clearFinished(params.spaceId,{dryRun,expected});
    }
    if(['chat.open','chat.subscribe','chat.unsubscribe','chat.history'].includes(method)){
      if(typeof params.taskId==='string' && params.taskId.startsWith('legacy-')){
        if(method==='chat.unsubscribe'){peer.chats.delete(params.taskId);return {unsubscribed:true};}
        if(method==='chat.history')throw failure('unsupported');
        const snapshot=await migration?.chat(params.spaceId,params.taskId,peer.windowBinding.folders,generation);
        if(peer.closed || peer.signal.aborted)throw failure('stale_instance');
        if(!snapshot)throw failure('unknown_task');return snapshot;
      }
      const task=tasks().get(params.taskId);
      if(method==='chat.unsubscribe'){if(peer.chats.delete(task.taskId))changed(task.space);return {unsubscribed:true};}
      if(method==='chat.history')return tasks().duringTask(task,()=>require('./service-task-chat.cjs').history({core:core(),tasks:tasks(),task,cursor:params.cursor}));
      if(method==='chat.open' && task.closedAt){delete task.closedAt;tasks().save(task);}
      const result=require('./service-task-chat.cjs').snapshot({core:core(),tasks:tasks(),task,generation,revision:chatRevisions.get(task.taskId) || 0});
      if(!peer.chats.has(task.taskId)){peer.chats.set(task.taskId,task.space);changed(task.space);}
      return result;
    }
    if (method === 'space.unsubscribe') {
      if (peer.subscriptions.delete(params.spaceId)) changed(params.spaceId);
      return {unsubscribed:true};
    }
    if (method !== 'space.subscribe') throw failure('invalid_argument');
    const limit = params.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw failure('invalid_argument');
    const subscribed = peer.subscriptions.has(params.spaceId);
    peer.subscriptions.set(params.spaceId, limit);
    if (!subscribed) changed(params.spaceId);
    return snapshot(params.spaceId, limit,peer,params.archiveView===true);
  }
  return {hello, bound, call, changed,chatChanged,
    sessionChanged(session){const task=[...tasks().tasks.values()].find(task=>task.sessionKey===session.key);if(task)chatChanged(task);},
    chatWindows:taskId=>[...peers].filter(peer=>peer.chats.has(taskId)).length,
    stop() { for (const peer of [...peers]) peer.close(); }};
}
module.exports = {createWindowRpc, windowBinding};
