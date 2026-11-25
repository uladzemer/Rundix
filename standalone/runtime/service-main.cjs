const {startService, locations} = require('./service-endpoint.cjs');
const {idleExit} = require('./service-lifecycle.cjs');
const {createHeadlessHost} = require('./service-headless-host.cjs');
const {createTaskRpc} = require('./service-task-rpc.cjs');
const {createLimitPoller} = require('./service-limit-poller.cjs');
const {handoverTarget, restartTarget} = require('./service-version.cjs');
const {cleanupServiceRoot} = require('./service-root-cleanup.cjs');
const serviceVersion = require('../package.json').version;

// Startup failures used to exit silently. Only a short code or error class is recorded: no message, path or user data.
function reportStartFailure(options, error, stderr = process.stderr) {
  const safe = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(value) ? value : null;
  const errorCode = safe(error?.code) || safe(error?.name) || 'Error';
  try { require('./service-headless-host.cjs').boundedLogger(locations(options).directory)({code:'service_start_failed', errorCode}); }
  catch { try { stderr.write('service_start_failed ' + errorCode + '\n'); } catch {} }
}
// Singleton is acquired before creating core, provider or CLI.
async function runService(options = {}) {
  const rpc = createTaskRpc({providerOptions:options.hostOptions?.providerOptions});
  const root = locations(options).directory;
  const endpoint = await startService({...options, entryPath:__filename, serviceVersion,
    ipc:{...options.ipc, hello:rpc.hello, getHandlerTimeoutMs:rpc.getHandlerTimeoutMs}, call:rpc.call});
  if (endpoint.status !== 'owner') return endpoint;
  const cleanupStop = new AbortController();
  const rootCleanup = cleanupServiceRoot(root,{signal:cleanupStop.signal}).catch(() => 0);
  let host, idle, poller,migration;
  try {
    migration=require('./service-migration.cjs').createMigration({root,...options.migrationOptions});
    await migration.sync();
    host = await createHeadlessHost({...options.hostOptions, root, generation:endpoint.generation,onSessionChanged:rpc.sessionChanged,
      taskOptions:{...options.hostOptions?.taskOptions, scope:rpc.scope, signal:rpc.signal, changed:rpc.changed,
        archiveChanged:rpc.archiveChanged, chatSubscribed:rpc.chatSubscribed}});
    poller = createLimitPoller({host, ...options.pollerOptions});
    void rootCleanup.then(removed=>{if(removed)host.logger({code:'service_root_cleanup',removed});}).catch(()=>{});
    let disposal,hostStopped=false,retry;
    const dispose = async () => {
      if(disposal)return disposal;
      if (!hostStopped && (host.busy() || poller.busy || endpoint.busy() || endpoint.clients())) return {exiting:false};
      endpoint.pause();rpc.stop();poller.pause();
      disposal=(async()=>{
        try {
          await host.dispose();hostStopped=true;cleanupStop.abort();
          await endpoint.dispose();await migration.close();poller.dispose();idle?.dispose();clearTimeout(retry);return {exiting:true};
        } catch(error) {
          if(!hostStopped){endpoint.resume();rpc.resume();poller.resume();}
          else {endpoint.pause();clearTimeout(retry);retry=setTimeout(()=>{void dispose().catch(()=>{});},1000);retry.unref?.();}
          throw error;
        }
      })().finally(()=>{disposal=null;});
      return disposal;
    };
    const shutdown=async({retire=false}={})=>{
      cleanupStop.abort();
      endpoint.pause({allowProbe:retire});rpc.stop();poller.dispose();idle?.dispose();clearTimeout(retry);
      try{await host.dispose(retire ? {force:true,confirmProviderExit:true} : {force:true});}
      finally{
        if(retire)await closeTransport();
        else {await endpoint.dispose();await migration.close();}
      }
    };
    let retiring=false, online=false;
    const {quietMs=60000, checkMs=5000, failureBackoffMs=600000, now=()=>performance.now()}=options.handoverOptions || {};
    let quietSince=null, nextCheck=0, activity=-1;
    const busy = peer => host.handoverBusy() || poller.busy || endpoint.handoverBusy(peer);
    const resume = () => {
      retiring=false;quietSince=null;
      endpoint.resume();rpc.resume();host.mcp.tasks.resume();poller.resume();migration.resume();
    };
    function admitRetirement(force, peer) {
      endpoint.pause({allowProbe:true});rpc.stop();host.mcp.tasks.pause();poller.pause();migration.pause();
      try {
        if (!force && (busy(peer) || migration.busy)) {resume();return false;}
      } catch (error) {resume();throw error;}
      retiring=true;
      return true;
    }
    const logFailure = () => host.logger({code:'idle_exit_failed'});
    async function closeTransport() {
      try {await migration.close({waitForRegistrations:true});await endpoint.dispose();}
      catch {endpoint.pause({allowProbe:true});logFailure();retry=setTimeout(()=>void closeTransport(),1000);}
    }
    async function finishRetirement(force, automatic=false) {
      if (force) {await shutdown({retire:true});return;}
      try {await host.dispose({confirmProviderExit:true});}
      catch {
        if (automatic) nextCheck=now()+failureBackoffMs;
        resume();logFailure();return;
      }
      cleanupStop.abort();idle.dispose();poller.dispose();
      await closeTransport();
    }
    function busyResult() {
      const activeTasks=host.mcp.tasks.unfinishedCount();
      return {result:{retiring:false,activeTasks,reason:activeTasks ? 'tasks' : 'transient'}};
    }
    function retire(force, peer, context) {
      if (!force && (busy(peer) || migration.busy)) return busyResult();
      if (!restartTarget(root)) return {error:{code:'service_install_required',message:'Service installation is unavailable.'}};
      if (!admitRetirement(force,peer)) return busyResult();
      context.afterResponse(error=>{
        if (error) resume();
        else void finishRetirement(force).catch(logFailure);
      });
      return {result:{retiring:true}};
    }
    function onTick() {
      if (retiring) return true;
      if (!online || disposal || hostStopped) return false;
      host.mcp.tasks.sweepArchive();
      const time=now(), observed=endpoint.activity()+migration.activity+host.handoverActivity();
      const occupied=busy();
      if (activity!==observed || occupied) quietSince=null;
      activity=observed;
      if (occupied) return false;
      quietSince ??= time;
      // Migration records real changes in its activity counter and blocks admission
      // while a pass is running. A failed retry does not restart the quiet window.
      if (time-quietSince < quietMs || time < nextCheck || migration.busy) return false;
      nextCheck=time+checkMs;
      if (!handoverTarget(root,serviceVersion) || !admitRetirement(false)) return false;
      void finishRetirement(false,true).catch(logFailure);
      return true;
    }
    rpc.attach(host, endpoint.generation,migration,retire);
    idle = idleExit({clients:() => endpoint.clients(), busy:() => endpoint.busy() || host.busy(), onIdle:dispose,onTick,
      idleMs:options.idleMs, pollMs:options.pollMs, log:host.logger});
    await endpoint.ready();
    online=true;
    return {status:'owner', host, endpoint, poller, dispose, shutdown};
  } catch (error) { cleanupStop.abort();idle?.dispose(); poller?.dispose(); await endpoint.dispose();await migration?.close(); throw error; }
}
if (require.main === module) {
  const index = process.argv.indexOf('--service-root');
  let service;
  const started=runService({root:index < 0 ? undefined : process.argv[index + 1]}).then(value=>{service=value;return value;});
  require('./service-fatal.cjs').installFatalGuards({
    log:value=>{if(service?.host)service.host.logger(value);else process.stderr.write('host_error\n');},
    shutdown:async()=>{await started.catch(()=>{});await service?.shutdown?.();}
  });
  started.catch(error=>{process.exitCode=1;reportStartFailure({root:index < 0 ? undefined : process.argv[index + 1]},error);});
}
module.exports = {runService, reportStartFailure};
