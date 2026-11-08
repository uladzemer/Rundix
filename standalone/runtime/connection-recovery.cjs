// Called only while the host owns the credential lease. Providers own account
// policy; the host owns the idle barrier and replacement of the CLI.
async function recoverConnection(deps, requiredConnection) {
  const connection = await deps.connections.resolve();
  if (requiredConnection && (connection.id !== requiredConnection.id || connection.revision !== requiredConnection.revision || !connection.provider))
    throw Error('MCP task connection changed.');
  if (!connection.provider?.recoverConnection) return;
  const client = deps.server;
  const assertCanChange = () => {
    deps.connections.assertCurrent(connection);
    if (deps.server !== client) throw Object.assign(Error('The connection changed. Retry.'), {retryable:true});
    if ([...deps.sessions.values()].some(session => session.busy || session.compacting))
      throw Object.assign(Error('Finish active tasks before changing the connection.'), {retryable:true});
    try { deps.store.assertNoActiveTurns(); }
    catch (error) { throw Object.assign(error, {retryable:true}); }
  };
  const changed = await connection.provider.recoverConnection({assertCanChange});
  deps.connections.assertCurrent(connection);
  if (changed === true) deps.connections.menu?.clear();
  if (changed === true && client) deps.connectionRecoveryPending = {client, connection};
  const pending = deps.connectionRecoveryPending;
  if (pending && pending.client === client && pending.connection.provider === connection.provider && pending.connection.revision === connection.revision) {
    assertCanChange();
    await deps.resetConnection();
    if (deps.connectionRecoveryPending === pending) deps.connectionRecoveryPending = null;
  }
}
module.exports = {recoverConnection};
