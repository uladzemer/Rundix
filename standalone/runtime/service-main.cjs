const {startService, locations} = require('./service-endpoint.cjs');
const {idleExit} = require('./service-lifecycle.cjs');
const {createHeadlessHost} = require('./service-headless-host.cjs');
const {createTaskRpc} = require('./service-task-rpc.cjs');
const {createLimitPoller} = require('./service-limit-poller.cjs');

// Singleton is acquired before creating core, provider or CLI.
async function runService(options = {}) {
  const rpc = createTaskRpc({providerOptions:options.hostOptions?.providerOptions});
  const endpoint = await startService({...options, entryPath:__filename, serviceVersion:require('../package.json').version,
    ipc:{...options.ipc, hello:rpc.hello, getHandlerTimeoutMs:rpc.getHandlerTimeoutMs}, call:rpc.call});
  if (endpoint.status !== 'owner') return endpoint;
  let host, idle, poller;
  try {
    host = await createHeadlessHost({...options.hostOptions, root:locations(options).directory, generation:endpoint.generation,
      taskOptions:{...options.hostOptions?.taskOptions, scope:rpc.scope, signal:rpc.signal}});
    rpc.attach(host); poller = createLimitPoller({host, ...options.pollerOptions});
    const dispose = async () => {
      if (host.busy() || poller.busy || endpoint.busy() || endpoint.clients()) return {exiting:false};
      rpc.stop(); poller.dispose(); await host.dispose(); await endpoint.dispose(); idle?.dispose(); return {exiting:true};
    };
    idle = idleExit({clients:() => endpoint.clients(), busy:() => endpoint.busy() || host.busy(), onIdle:dispose,
      idleMs:options.idleMs, pollMs:options.pollMs, log:host.logger});
    await endpoint.ready();
    return {status:'owner', host, endpoint, poller, dispose};
  } catch (error) { idle?.dispose(); poller?.dispose(); await endpoint.dispose(); throw error; }
}
if (require.main === module) {
  const index = process.argv.indexOf('--service-root');
  runService({root:index < 0 ? undefined : process.argv[index + 1]}).catch(() => {process.exitCode = 1;});
}
module.exports = {runService};
