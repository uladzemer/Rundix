// Window projections are connection-owned. Disconnect never changes task state.
const {randomUUID} = require('node:crypto');
const {fileURLToPath} = require('node:url');
const {resolveSpace, canonical} = require('./service-space.cjs');
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

function createWindowRpc({generation, tasks}) {
  const peers = new Set(), revisions = new Map();
  const revision = spaceId => revisions.get(spaceId) || 0;
  function changed(spaceId) {
    revisions.set(spaceId, revision(spaceId) + 1);
    for (const peer of peers) if (peer.subscriptions.has(spaceId)) {
      try { peer.send({method:'space.changed', params:{generation, schemaVersion:1, spaceId, viewRevision:revision(spaceId)}}); }
      catch { peer.close(); }
    }
  }
  function hello(params, peer) {
    const binding = windowBinding(params.binding);
    peer.windowBinding = binding; peer.subscriptions = new Map(); peers.add(peer);
    peer.once('closed', () => {
      peers.delete(peer);
      for (const spaceId of peer.subscriptions.keys()) changed(spaceId);
      peer.subscriptions.clear();
    });
    return {bindingId:binding.bindingId, spaces:[...binding.spaces.values()], toolSchemaVersion:1,
      capabilities:['tasks.v1', 'limitWait.v1', 'spaceSnapshot.v1']};
  }
  function bound(params, peer) {
    return peer.windowBinding?.bindingId === params.bindingId && peer.windowBinding.spaces.has(params.spaceId);
  }
  function snapshot(spaceId, limit) {
    const serviceTasks = tasks();
    const order = (a,b) => Number(active.has(b.state)) - Number(active.has(a.state)) || b.createdAt - a.createdAt || a.taskId.localeCompare(b.taskId);
    const page = []; let totalTasks = 0;
    function include(task) {
      if (task.space !== spaceId) return;
      totalTasks++; page.push(task); page.sort(order);
      if (page.length > limit) page.pop();
    }
    for (const task of serviceTasks.tasks.values()) include(task);
    // Restored/crash-duplicate active records take precedence over the archive.
    for (const task of serviceTasks.archive?.records() || []) if (!serviceTasks.tasks.has(task.taskId)) include(task);
    const result = {generation, schemaVersion:1, spaceId, viewRevision:revision(spaceId),
      tasks:page.map(task => serviceTasks.summary(task)),
      chats:page.filter(task => task.chatId).map(task => ({taskId:task.taskId, chatId:task.chatId,
        owner:'service', title:('MCP · ' + task.description).slice(0,167), visibility:task.closedAt ? 'closed' : 'open'})),
      windows:[...new Set([...peers].filter(peer => peer.subscriptions.has(spaceId)).map(peer => peer.windowBinding.windowId))]
        .map(windowId => ({windowId})), totalTasks, hasMoreHistory:totalTasks > page.length};
    // No partial projection masquerades as a full snapshot; preserve stored data.
    if (Buffer.byteLength(JSON.stringify(result)) > 768 * 1024) throw failure('response_too_large');
    return result;
  }
  function call(method, params, peer) {
    if (!bound(params, peer)) throw failure('space_not_bound');
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
    return snapshot(params.spaceId, limit);
  }
  return {hello, bound, call, changed, stop() { for (const peer of [...peers]) peer.close(); }};
}
module.exports = {createWindowRpc, windowBinding};
