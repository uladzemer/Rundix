// Shared demand-start connection; callers supply their own hello and capabilities.
const {spawn} = require('node:child_process');
const {setTimeout:delay} = require('node:timers/promises');
const {locations, connectService, probeOwner} = require('./service-endpoint.cjs');
const {registration} = require('./service-launcher.cjs');
const {serviceEnvironment} = require('./service-environment.cjs');
const failure = code => Object.assign(Error('The background service is unavailable.'), {code});
function createServiceConnection(options = {}, hello = {}) {
  const root = locations(options).directory;
  const lifetime=new AbortController(), {signal}=lifetime;
  let peer, connecting;
  async function connect() {
    signal.throwIfAborted();
    if (peer && !peer.closed) return peer;
    if (connecting) return connecting;
    connecting = (async () => {
      const deadline = Date.now() + (options.startupTimeoutMs || 20000);
      const probe=async extra=>{
        const remaining=deadline-Date.now();
        if(remaining<=0)throw failure('service_start_timeout');
        const timer=new AbortController(), probeSignal=AbortSignal.any([signal,timer.signal]);
        try {
          return await Promise.race([
            probeOwner({...options,...extra,root,signal:probeSignal}),
            delay(remaining,undefined,{signal:probeSignal}).then(()=>{throw failure('service_start_timeout');})
          ]);
        } finally {timer.abort();}
      };
      const owner = await probe();
      const launched=new Set();let unpublished=false,observedGeneration='initial';
      const startOwner=state=>{
      signal.throwIfAborted();
      if(state.state==='responding'){unpublished=false;observedGeneration=state.generation;}
      if (['absent','dead'].includes(state.state)) {
        if(state.state==='absent' && unpublished)return;
        const generation=state.generation || 'absent-after:'+observedGeneration;if(launched.has(generation))return;launched.add(generation);unpublished=true;
        const installed = registration(root);
        const env = serviceEnvironment();
        const child = (options.spawnProcess || spawn)(installed.nodePath, [installed.entryPath, '--service-root', root],
          {shell:false, detached:true, windowsHide:true, stdio:'ignore', cwd:root, env});
        child.on('error', () => {}); child.unref();
      }
      };
      startOwner(owner);
      const onUnavailable=async()=>{
        const remaining=deadline-Date.now();if(remaining<=0)throw failure('service_start_timeout');
        const state=await probe({pingTimeoutMs:Math.min(1000,remaining)});
        if(Date.now()<deadline)startOwner(state);
      };
      if (Date.now() >= deadline) throw failure('service_start_timeout');
      const connected = await connectService({...options, root, signal,startupTimeoutMs:deadline - Date.now(), onUnavailable, hello});
      if (signal.aborted) { connected.close(); signal.throwIfAborted(); }
      peer = connected;
      connected.once('closed', () => { if (peer === connected) peer = null; });
      return connected;
    })().catch(error=>{signal.throwIfAborted();throw error;}).finally(() => { connecting = null; });
    return connecting;
  }
  return {connect, close() {lifetime.abort(failure('service_unavailable'));peer?.close();}};
}
module.exports = {createServiceConnection};
