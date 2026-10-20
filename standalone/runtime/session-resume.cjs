// Host state is supplied explicitly; mutable values are read through deps.
async function resume(deps, s, id) {
  if (s.loading) return s.loading;
  s.loading = deps.resumeThread(s, id);
  try {
    return await s.loading;
  } finally {
    s.loading = null;
  }
}

async function resumeThread(deps, s, id) {
  // Serialize reloads with best-effort MCP cleanup, including a tab reopened while it is in flight.
  await deps.threadReleases.get(id)?.catch(()=>{});
  await deps.connect();
  if (s.id === id && s.loaded) return;
  const existing = [...deps.sessions.values()].find(
    (other) => other !== s && other.id === id && other.panel,
  );
  if (existing) {
    deps.select(existing);
    return;
  }
  const result = await deps.server.request("thread/resume", {
    threadId: id,
    excludeTurns: true,
    ...(s.preflight?.enabled?{config:await deps.preparationConfig(s),...(deps.preflight.preparing(s.preflight)?{sandbox:'read-only',approvalPolicy:'never'}:{})}:deps.mcpThreadConfig(s)?{config:deps.mcpThreadConfig(s)}:{}),
  });
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
    const turns = await deps.server.request("thread/turns/list", {
      threadId: id,
      limit: 1,
      sortDirection: "desc",
      itemsView: "summary",
    });
    if (s.busy)
      s.turnId = turns.data?.find((turn) => turn.status === "inProgress")?.id;
    else s.lastTurnStatus=turns.data?.[0]?.status;
  }
  const page = await deps.server.request("thread/items/list", {
    threadId: id,
    limit: 200,
    sortDirection: "desc",
  });
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
module.exports = { resume, resumeThread };
