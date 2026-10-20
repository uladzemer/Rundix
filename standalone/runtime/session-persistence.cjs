// Host state is supplied explicitly; mutable values are read through deps.
async function save(deps, s) {
  const record = {
    key: s.key,
    id: s.id,
    name: s.name,
    customName: s.customName,
    model: s.model,
    effort: s.effort,
    prefs: s.prefs,
    draft: s.draft || "",
    attachments: s.attachments,
    followUps:s.followUps || [],
    queuePaused: !!s.queuePaused,
    asyncQuestionReplies:s.asyncQuestionReplies || {},
    questionHistory:s.questionHistory || [],
    preflight:s.preflight || null,
    cwd: s.cwd,
    parentId: s.parentId,
    items: s.items.slice(-200),
    tokenUsage: s.tokenUsage,
    usageModel: s.usageModel,
    usageStale: !!s.usageStale,
    lastTurnStatus:s.lastTurnStatus,
    mcpTask:!!s.mcpTask,
  };
  const written = deps.store.saveSession(record, s.persistedRecord);
  for (const key of Object.keys(record))
    if (
      s.persistedRecord &&
      JSON.stringify(record[key]) === JSON.stringify(s.persistedRecord[key])
    )
      s[key] = written[key];
  s.persistedRecord = JSON.parse(JSON.stringify(written));
  await deps.workspaceState.update("session:" + s.key, written);
}

async function syncExternal(deps, s) {
  if (s.busy) return;
  const latest = deps.store.session(s.key),
    base = s.persistedRecord;
  if (!latest || latest.revision === base?.revision) return;
  const changedHistory =
    !!s.id && JSON.stringify(latest.items) !== JSON.stringify(base?.items);
  if (changedHistory && s.loaded) {
    if ([...deps.sessions.values()].some((other) => other.busy))
      throw Error(
        deps.locale.t(
          "История обновилась в другом окне. Завершите текущие задачи в этом окне перед продолжением.",
        ),
      );
    if (deps.pendingLogin.current?.client === deps.server) deps.pendingLogin.finish();
    deps.server?.dispose();
    deps.connecting = null;
  }
  for (const key of [
    "name",
    "customName",
    "draft",
    "attachments",
    "followUps",
    "queuePaused",
    "prefs",
    "preflight",
    "model",
    "effort",
    "cwd",
    "parentId",
    "items",
    "tokenUsage",
    "usageModel",
    "usageStale",
  ])
    if (
      JSON.stringify(s[key]) === JSON.stringify(base?.[key]) ||
      (key === "items" && changedHistory) || key==='preflight'
    )
      s[key] = latest[key];
  s.persistedRecord = JSON.parse(JSON.stringify(latest));
  if (changedHistory) { s.loaded = false; s.lastStartedTurnId = null; }
}
module.exports = { save, syncExternal };
