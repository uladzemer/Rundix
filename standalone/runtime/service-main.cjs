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
  let host, idle, poller,migration;
  try {
    migration=require('./service-migration.cjs').createMigration({root:locations(options).directory,...options.migrationOptions});
    await migration.sync();
    host = await createHeadlessHost({...options.hostOptions, root:locations(options).directory, generation:endpoint.generation,onSessionChanged:rpc.sessionChanged,
      beforeAdmission:async()=>{await migration.sync();},
      taskOptions:{...options.hostOptions?.taskOptions, scope:rpc.scope, signal:rpc.signal, changed:rpc.changed}});
    rpc.attach(host, endpoint.generation,migration); poller = createLimitPoller({host, ...options.pollerOptions});
    let disposal,hostStopped=false,retry;
    const dispose = async () => {
      if(disposal)return disposal;
      if (!hostStopped && (host.busy() || poller.busy || endpoint.busy() || endpoint.clients())) return {exiting:false};
      endpoint.pause();rpc.stop();poller.pause();
      disposal=(async()=>{
        try {
          await host.dispose();hostStopped=true;
          await endpoint.dispose();await migration.close();poller.dispose();idle?.dispose();clearTimeout(retry);return {exiting:true};
        } catch(error) {
          if(!hostStopped){endpoint.resume();rpc.resume();poller.resume();}
          else {endpoint.pause();clearTimeout(retry);retry=setTimeout(()=>{void dispose().catch(()=>{});},1000);retry.unref?.();}
          throw error;
        }
      })().finally(()=>{disposal=null;});
      return disposal;
    };
    idle = idleExit({clients:() => endpoint.clients(), busy:() => endpoint.busy() || host.busy(), onIdle:dispose,
      idleMs:options.idleMs, pollMs:options.pollMs, log:host.logger});
    await endpoint.ready();
    const shutdown=async()=>{
      endpoint.pause();rpc.stop();poller.dispose();idle?.dispose();clearTimeout(retry);
      try{await host.dispose({force:true});}finally{await endpoint.dispose();await migration.close();}
    };
    return {status:'owner', host, endpoint, poller, dispose, shutdown};
  } catch (error) { idle?.dispose(); poller?.dispose(); await endpoint.dispose();await migration?.close(); throw error; }
}
if (require.main === module) {
  const index = process.argv.indexOf('--service-root');
  let service;
  const started=runService({root:index < 0 ? undefined : process.argv[index + 1]}).then(value=>{service=value;return value;});
  require('./service-fatal.cjs').installFatalGuards({
    log:value=>{if(service?.host)service.host.logger(value);else process.stderr.write('host_error\n');},
    shutdown:async()=>{await started.catch(()=>{});await service?.shutdown?.();}
  });
  started.catch(()=>{process.exitCode=1;});
}
module.exports = {runService};
