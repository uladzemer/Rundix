const {spawn} = require('node:child_process');
const {locations, connectService, probeOwner} = require('./service-endpoint.cjs');
const {launchBinding} = require('./service-space.cjs');
const {registration} = require('./service-launcher.cjs');
const {run, tools, wait} = require('./mcp-server.cjs');
const {serviceEnvironment} = require('./service-environment.cjs');

const failure = code => Object.assign(Error(code === 'service_start_timeout'
  ? 'Service owner is not responding. Check the installed service before retrying with the same requestId.'
  : 'The background service is unavailable.'), {code});
function createServiceClient(options = {}) {
  const root = locations(options).directory;
  const binding = launchBinding(options);
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
      const launched=new Set();let unpublished=false;
      const startOwner=state=>{
      if(state.state==='responding')unpublished=false;
      if (['absent','dead'].includes(state.state)) {
        if(state.state==='absent' && unpublished)return;
        const generation=state.generation || 'absent';if(launched.has(generation))return;launched.add(generation);unpublished=true;
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
      const connected = await connectService({...options, root, startupTimeoutMs:deadline - Date.now(), onUnavailable, hello:{clientKind:'adapter',
        binding:{source:binding.source, launchDirectory:binding.launchDirectory}}});
      if (closed) { connected.close(); throw failure('service_unavailable'); }
      if (connected.binding?.toolSchemaVersion !== 1 || !connected.binding?.capabilities?.includes('tasks.v1') ||
          !connected.binding?.capabilities?.includes('limitWait.v1')) {
        connected.close(); throw failure('protocol_incompatible');
      }
      peer = connected;
      connected.once('closed', () => { if (peer === connected) peer = null; });
      return connected;
    })().finally(() => { connecting = null; });
    return connecting;
  }
  async function call(_descriptor, name, args) {
    args ||= {};
    if (['wait_task','wait_tasks'].includes(name) && args.waitSeconds != null &&
        (!Number.isInteger(args.waitSeconds) || args.waitSeconds < 1 || args.waitSeconds > 1500))
      throw Object.assign(Error('Invalid waitSeconds'), {code:'invalid_argument'});
    const current = await connect();
    let response;
    try {
      response = await current.call('task.call', {bindingId:current.binding.bindingId,
        spaceId:current.binding.spaceId, name, arguments:args},
      ['wait_task','wait_tasks'].includes(name) ? ((args.waitSeconds || 600) + 15) * 1000 : 30000);
    } catch (error) { current.close(); throw failure(error.code === 'rpc_timeout' ? 'rpc_timeout' : 'service_unavailable'); }
    // Never replay an uncertain mutation. Caller retries explicitly with its requestId.
    if (response.error) throw Object.assign(Error(response.error.message), response.error);
    return response.result;
  }
  async function getTools() {
    await connect();
    return tools.filter(tool => tool.name !== 'reload_window').map(tool => {
      const copy = structuredClone(tool);
      if (copy.name === 'list_tasks') copy.inputSchema.properties.state.enum.push('waiting_limit');
      if (copy.name === 'close_task') copy.description = 'Close a finished task. The chat is kept for continue_task.';
      if (['wait_task','wait_tasks'].includes(copy.name)) copy.description += ' waiting_limit keeps waiting; at timeout or the quota reset checkpoint the snapshot includes waitingLimit. It does not need user attention.';
      return copy;
    });
  }
  return {call, getTools, close() { closed = true; peer?.close(); }, space:binding.spaceId};
}
function runServiceAdapter(options = {}) {
  const client = createServiceClient(options), input = options.input || process.stdin;
  input.once('end', () => client.close()); input.once('close', () => client.close());
  run(null, input, options.output || process.stdout, client);
  return client;
}
function main(options = {}) {
  const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  if (process.argv.includes('--recover-hung')) { process.stderr.write('recovery_required: Stop the verified service owner before retrying.\n'); process.exitCode = 1; return; }
  const taskId = arg('--wait'), timeout = Number(arg('--timeout') ?? 3600);
  if (process.argv.includes('--wait')) {
    if (!taskId || taskId.startsWith('--') || !Number.isInteger(timeout) || timeout < 1 || timeout > 86400) {
      process.stderr.write('Invalid --wait arguments.\n'); process.exitCode = 1; return;
    }
    const client = createServiceClient(options);
    const waitCall = async (...args) => {
      try { return await client.call(...args); }
      catch (error) {
        // Only these read-only waits reconnect; task mutations are never replayed.
        if (['service_unavailable','rpc_timeout','service_start_timeout'].includes(error.code)) error.code = 'bridge_unavailable';
        throw error;
      }
    };
    void wait(null, taskId, timeout, {call:waitCall, brief:process.argv.includes('--brief')})
      .then(code => { process.exitCode = code; }).finally(() => client.close());
  } else runServiceAdapter(options);
}
module.exports = {createServiceClient, runServiceAdapter, main};
