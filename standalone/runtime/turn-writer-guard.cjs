// Check the owning thread after a provider handoff. A stale local busy flag is
// not enough: the CLI may still hold the thread writer while the old process exits.
async function assertNoActiveWriter(deps, s) {
  const turns = await deps.server.request('thread/turns/list', {
    threadId: s.id, limit: 1, sortDirection: 'desc', itemsView: 'summary',
  });
  const active = turns?.data?.find(turn => turn.status === 'inProgress');
  if (!active) return;
  // This snapshot does not subscribe us to that writer's completion. Turning it
  // into local busy state would block every retry (and Reconnect) indefinitely.
  // Refuse this send; the next attempt must read the writer again.
  throw Object.assign(Error(deps.locale.t('Предыдущий ответ ещё выполняется. Дождитесь его завершения или переподключитесь.')),
    {notSent:true,retryable:true});
}
module.exports = {assertNoActiveWriter};
