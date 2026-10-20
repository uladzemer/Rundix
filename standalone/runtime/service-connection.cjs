// Shared demand-start connection; callers supply their own hello and capabilities.
const {spawn} = require('node:child_process');
const {locations, connectService, probeOwner} = require('./service-endpoint.cjs');
const {registration} = require('./service-launcher.cjs');
const {serviceEnvironment} = require('./service-environment.cjs');
const failure = code => Object.assign(Error('The background service is unavailable.'), {code});
function createServiceConnection(options = {}, hello = {}) {
  const root = locations(options).directory;
  let peer, connecting, closed = false;
  async function connect() {
    if (closed) throw failure('service_unavailable');
    if (peer && !peer.closed) return peer;
    if (connecting) return connecting;
    connecting = (async () => {
      const deadline = Date.now() + (options.startupTimeoutMs || 20000);
      let timer;
      const owner = await Promise.race([probeOwner({...options, root}), new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('service_start_timeout')), Math.max(1, deadline - Date.now()));
      })]).finally(() => clearTimeout(timer));
      const launched=new Set();let unpublished=false,observedGeneration='initial';
      const startOwner=state=>{
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
        let timer;
        const state=await Promise.race([probeOwner({...options,root,pingTimeoutMs:Math.min(1000,remaining)}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('service_start_timeout')),remaining);})]).finally(()=>clearTimeout(timer));
        if(Date.now()<deadline)startOwner(state);
      };
      if (Date.now() >= deadline) throw failure('service_start_timeout');
      const connected = await connectService({...options, root, startupTimeoutMs:deadline - Date.now(), onUnavailable, hello});
      if (closed) { connected.close(); throw failure('service_unavailable'); }
      peer = connected;
      connected.once('closed', () => { if (peer === connected) peer = null; });
      return connected;
    })().finally(() => { connecting = null; });
    return connecting;
  }
  return {connect, close() {closed = true; peer?.close();}};
}
module.exports = {createServiceConnection};
