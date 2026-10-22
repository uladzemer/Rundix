// Host state is supplied explicitly; mutable values are read through deps.
async function resume(deps, s, id) {
  if (s.loading) return s.loading;
  const loading = s.loading = deps.resumeThread(s, id);
  try {
    return await loading;
  } catch (error) {
    // Service only: every caller (MCP start, send, status) then starts a fresh thread
    // for the unsent input instead of retrying an impossible resume forever.
    if (!deps.serviceMode || s.id !== id || !lostEmptyThread(s, error)) throw error;
    s.id = null; s.loaded = false;
    await deps.save(s);
  } finally {
    if (s.loading === loading) s.loading = null;
  }
}

async function resumeOptions(deps,s,id) {
  return {threadId:id,excludeTurns:true,
    ...(s.preflight?.enabled?{config:await deps.preparationConfig(s),...(deps.preflight.preparing(s.preflight)?{sandbox:'read-only',approvalPolicy:'never'}:{})}:deps.mcpThreadConfig(s)?{config:deps.mcpThreadConfig(s)}:{})};
}

async function resumeThread(deps, s, id) {
  const originalId = s.id;
  // Serialize reloads with best-effort MCP cleanup, including a tab reopened while it is in flight.
  await deps.threadReleases.get(id)?.catch(()=>{});
  await deps.connect();
  if (s.id !== originalId)
    throw Object.assign(new Error('Chat changed while restoring the thread. Retry when connected.'), { code: 'STALE_SESSION_RESUME' });
  if (s.id === id && s.loaded) return;
  const existing = [...deps.sessions.values()].find(
    (other) => other !== s && other.id === id && deps.hasChat(other),
  );
  if (existing) {
    deps.select(existing);
    return;
  }
  const client = deps.server, epoch = deps.limitsEpoch;
  const assertCurrent = () => {
    if (client !== deps.server || epoch !== deps.limitsEpoch || s.id !== originalId)
      throw Object.assign(new Error('Connection or chat changed while restoring the thread. Retry when connected.'), { code: 'STALE_SESSION_RESUME' });
  };
  const options = await resumeOptions(deps,s,id);
  assertCurrent();
  const result = await client.request("thread/resume", options);
  assertCurrent();
  const turns = await client.request("thread/turns/list", {
    threadId: id, limit: 1, sortDirection: "desc", itemsView: "summary",
  });
  assertCurrent();
  const page = await client.request("thread/items/list", {
    threadId: id, limit: 200, sortDirection: "desc",
  });
  assertCurrent();
  // Commit only a complete snapshot from the owning connection. A reset must
  // never leave a partially restored chat marked as loaded on its replacement.
  s.id = id;
  s.cwd = result.thread.cwd || s.cwd;
  s.parentId = result.thread.forkedFromId || s.parentId;
  s.model = result.model;
  s.turnModel = result.model;
  s.effort = result.reasoningEffort;
  if(typeof s.prefs.fast!=='boolean')s.prefs.fast=['fast','priority'].includes(result.serviceTier);
  s.name = result.thread.name || result.thread.preview || "Rundix";
  s.busy = result.thread.status?.type === "active";
  if(!s.busy&&s.preflight?.phase==='executing')s.preflight.phase='review';
  {
    if (s.busy)
      s.turnId = turns.data?.find((turn) => turn.status === "inProgress")?.id;
    else {
      if(deps.serviceMode)s.turnId=null;
      s.lastTurnStatus=turns.data?.[0]?.status;
      if(deps.serviceMode)s.lastReadTurnId=turns.data?.[0]?.id;
      if(deps.serviceMode)s.error=turns.data?.[0]?.error?.message || null;
    }
  }
  const previousTimes = new Map(s.items.map(item => [item.id, item.timestamp]));
  s.items = (page.data || []).slice().reverse().map(entry => {
    const item = deps.readItem(entry);
    item.timestamp ??= previousTimes.get(item.id);
    return item;
  });
  s.cursor = page.nextCursor;
  deps.questionRecords.restore(s);
  s.loaded = true;
  await deps.save(s);
  deps.publish(s);
}
// Codex writes a rollout only with the first turn: a thread that never ran is
// lost when its app-server exits, and holds nothing worth recovering.
function lostEmptyThread(s, error) {
  return (error?.missingRollout === true || /no rollout/i.test(error?.message || '')) && !s.lastStartedTurnId && !s.lastTurnStatus && !(s.items || []).length;
}

module.exports = { resume, resumeThread, resumeOptions, lostEmptyThread };
