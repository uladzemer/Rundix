const {startService, locations} = require('./service-endpoint.cjs');
const {idleExit} = require('./service-lifecycle.cjs');
const {createHeadlessHost} = require('./service-headless-host.cjs');

// Singleton is acquired before creating core, provider or CLI. Until space
// binding is installed, this entry deliberately exposes no task RPC or metadata.
async function runService(options = {}) {
  const endpoint = await startService({...options, entryPath:__filename, serviceVersion:require('../package.json').version,
    call:options.dispatch || (() => {throw Object.assign(Error('Method unsupported.'), {code:'method_not_supported'});})});
  if (endpoint.status !== 'owner') return endpoint;
  let host, idle;
  try {
    host = await createHeadlessHost({root:locations(options).directory, generation:endpoint.generation, ...options.hostOptions});
    const dispose = async () => {
      if (host.busy() || endpoint.busy() || endpoint.clients()) return {exiting:false};
      await host.dispose(); await endpoint.dispose(); idle?.dispose(); return {exiting:true};
    };
    idle = idleExit({clients:() => endpoint.clients(), busy:() => endpoint.busy() || host.busy(), onIdle:dispose,
      idleMs:options.idleMs, pollMs:options.pollMs, log:host.logger});
    await endpoint.ready();
    return {status:'owner', host, endpoint, dispose};
  } catch (error) { idle?.dispose(); await endpoint.dispose(); throw error; }
}
if (require.main === module) runService().catch(() => {process.exitCode = 1;});
module.exports = {runService};
