const {AsyncLocalStorage} = require('node:async_hooks');
const {randomUUID} = require('node:crypto');
const {resolveSpace} = require('./service-space.cjs');
const {readProviderConfigAsync} = require('./service-provider-config.cjs');
const {createWindowRpc} = require('./service-window-rpc.cjs');
const budget = (name, args) => ['wait_task', 'wait_tasks'].includes(name)
  ? (Number.isInteger(args?.waitSeconds) ? Math.max(1, Math.min(1500, args.waitSeconds)) : 600) * 1000 + 15000 : 12000;
const TOOLS = new Set(['submit_task', 'get_task', 'wait_task', 'wait_tasks', 'list_tasks', 'continue_task', 'cancel_task', 'close_task', 'list_models', 'reload_window']);
const SAFE = new Set(['unknown_task', 'space_not_bound', 'stale_instance', 'invalid_argument', 'invalid_directory', 'request_conflict', 'task_active',
  'connection_unavailable', 'approval_not_pending', 'approval_rejected', 'delivery_unknown', 'response_too_large', 'storage_unavailable', 'limit', 'unsupported']);
const failure = code => Object.assign(Error(code), {code});
function createTaskRpc({providerOptions = {}} = {}) {
  const scope = new AsyncLocalStorage(); let host, windows, stopping = false;
  function hello(params, peer) {
    if (stopping) throw failure('service_initializing');
    if (params.clientKind === 'window') {
      if (!windows) throw failure('service_initializing');
      return windows.hello(params, peer);
    }
    if (params.clientKind !== 'adapter' || !params.binding || !['cwd', 'claude_project_dir'].includes(params.binding.source)) throw failure('auth_failed');
    const space = resolveSpace(params.binding.launchDirectory);
    const binding = {bindingId:randomUUID(), spaceId:space.spaceId}; peer.spaceBinding = binding;
    return {...binding, toolSchemaVersion:1, capabilities:['tasks.v1', 'limitWait.v1']};
  }
  async function call(method, params, peer, context) {
    if (stopping || !host) throw failure('service_initializing');
    const isWindow = !!peer.windowBinding;
    const binding = isWindow ? {spaceId:params.spaceId} : peer.spaceBinding;
    if (isWindow ? !windows.bound(params, peer) : !binding || params.bindingId !== binding.bindingId || params.spaceId !== binding.spaceId)
      return {error:{code:'space_not_bound', message:'Space is not bound.'}};
    if (isWindow && ['space.subscribe','space.unsubscribe'].includes(method)) {
      try {return {result:windows.call(method, params, peer)};}
      catch (error) {return {error:{code:SAFE.has(error.code) ? error.code : 'rejected', message:'Request rejected.'}};}
    }
    if (method !== 'task.call' || !TOOLS.has(params.name)) return {error:{code:'invalid_argument', message:'Unknown tool.'}};
    return scope.run({spaceId:binding.spaceId, signal:peer.signal}, async () => {
      try {
        if (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) throw failure('invalid_argument');
        // Ownership precedes provider/connection lookup, including mutation replay.
        if (params.arguments.taskId !== undefined) host.mcp.tasks.get(params.arguments.taskId);
        if (params.name === 'submit_task') await readProviderConfigAsync(providerOptions);
        if (context.signal.aborted || peer.signal.aborted) return null;
        if (params.name === 'reload_window') throw failure('unsupported');
        const value = await host.mcp.tasks.call(params.name, params.arguments);
        if (context.signal.aborted || peer.signal.aborted) return null;
        return {result:value};
      } catch (error) {
        const code = error?.reason === 'action_required' ? 'action_required' : SAFE.has(error?.code) ? error.code : 'rejected';
        return {error:{code, ...(code === 'action_required' ? {providerCode:error.code} : {}),
          message:code === 'action_required' ? 'Open the installed companion connection settings and reconnect.' : code === 'unknown_task' ? 'Unknown taskId' : 'Request rejected.'}};
      }
    });
  }
  return {scope:() => scope.getStore()?.spaceId, signal:() => scope.getStore()?.signal, hello, call,
    changed:task => windows?.changed(task.space),
    attach:(value, generation) => {host = value; windows = createWindowRpc({generation, tasks:() => host.mcp.tasks});},
    stop:() => {stopping = true;}, resume:()=>{stopping=false;},
    getHandlerTimeoutMs(method, params) {return method === 'task.call' ? budget(params?.name, params?.arguments) : 12000;}};
}
module.exports = {createTaskRpc};
