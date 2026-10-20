// Node host for service-owned MCP sessions. UI/editor callbacks never escape
// this module; neither the provider child nor an IPC caller receives core state.
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {randomUUID, createHash} = require('node:crypto');
const {SessionStore} = require('./store.cjs');
const {createSessionCore} = require('./session-core.cjs');
const {createMcpHost} = require('./mcp-host.cjs');
const {ServiceProvider} = require('./service-provider.cjs');
const {findCli} = require('./transport.cjs');
const {parseStrict} = require('./service-json.cjs');
const {boundedRead, actionRequired} = require('./service-provider-config.cjs');

const {plainSettings}=require('./service-settings.cjs');
function boundedLogger(root) {
  const directory = path.join(root, 'diagnostics'); fs.mkdirSync(directory, {recursive:true, mode:0o700});
  const file = index => path.join(directory, 'service-' + index + '.log');
  const codes = new Set(['host_error', 'service_started', 'service_stopped', 'idle_exit_failed', 'provider_unavailable']);
  return input => {
    const code = codes.has(input?.code) ? input.code : 'host_error';
    try {
      if (fs.existsSync(file(0)) && fs.statSync(file(0)).size >= 1024 * 1024) {
        try { fs.unlinkSync(file(2)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (fs.existsSync(file(1))) fs.renameSync(file(1), file(2));
        fs.renameSync(file(0), file(1));
      }
      fs.appendFileSync(file(0), JSON.stringify({at:Date.now(), code}) + '\n', {mode:0o600});
    } catch {} // Logging must never change send/recovery outcomes.
  };
}
function providerWait(outcome) {
  if (outcome.kind === 'waitUntil') return {waitId:outcome.waitId, resetAt:outcome.resetAt, reason:outcome.reason};
  const reason = {LIMITS_UNKNOWN:'limits_unknown', RESET_UNKNOWN:'reset_unknown', BUSY_ACTIVE:'active_turns'}[outcome.code];
  return reason ? {waitId:outcome.waitId, resetAt:null, reason, retryAfterMs:outcome.retryAfterMs || 0} : null;
}

async function createHeadlessHost({root, generation, providerOptions = {}, resolveCli, clock = {now:Date.now, setTimeout, clearTimeout},
  taskOptions = {}, decorateAdapter} = {}) {
  const settings = plainSettings(root), logger = boundedLogger(root);
  const kv = new SessionStore(path.join(root, 'state'));
  const workspaceState = {
    get(key, fallback) { return kv.read('value', createHash('sha256').update(key).digest('hex'))?.value ?? fallback; },
    async update(key, value) { kv.write('value', createHash('sha256').update(key).digest('hex'), {value}); },
  };
  const provider = new ServiceProvider({...providerOptions, serviceGeneration:generation});
  let core, mcp, disposed = false;
  const runs = new Map();
  const noop = () => {};
  const taskForThread = threadId => {
    const session = [...core.sessions.values()].find(session => session.id === threadId);
    return session && [...mcp.tasks.tasks.values()].find(task => task.sessionKey === session.key);
  };
  function finishRun(row, turnId) {
    if (row.turnId && row.turnId !== turnId || runs.get(row.threadId) !== row) return false;
    try { provider.terminal({turnLeaseId:row.grant.leaseId, taskId:row.taskId, runId:row.grant.runId, turnId}); }
    catch (error) { if (error.code !== 'STALE_FENCE') logger({code:'host_error'}); return false; }
    row.turnId = turnId; runs.delete(row.threadId); return true;
  }
  class HeadlessTransport extends EventEmitter {
    constructor(options) { super(); this.options = options; this.executable = options.executable; this.listeners = []; }
    async start() {
      await provider.start();
      const cli = provider.cli || provider.createCli(this.options); this.cli = cli;
      const on = (event, handler) => { cli.on(event, handler); this.listeners.push([event, handler]); };
      on('notification', message => {
        if (this.cli !== cli || disposed) return;
        const row = runs.get(message.params?.threadId);
        if (row && message.method === 'turn/completed') {
          const turnId = message.params?.turn?.id;
          if (typeof turnId === 'string') {
            if (row.completed.size < 32) row.completed.add(turnId);
            // The driver already observed this typed event on this CLI before
            // the facade listener runs. Validate it immediately: a later stale
            // completion cannot overwrite confirmed evidence while ACK waits.
            finishRun(row, turnId);
          }
        }
        this.emit('notification', message);
      });
      on('request', message => {
        // Refresh belongs exclusively to the v2 driver, which claims it once.
        if (message.method !== 'account/chatgptAuthTokens/refresh') this.emit('request', message);
      });
      on('disconnected', message => this.emit('disconnected', message));
      on('protocolError', message => this.emit('protocolError', message));
      return cli.start();
    }
    async request(method, params = {}, timeoutMs) {
      if (!this.cli || disposed) throw actionRequired('PROVIDER_UNAVAILABLE');
      if (method !== 'turn/start') return this.cli.request(method, params, timeoutMs);
      const task = taskForThread(params.threadId);
      if (!task || runs.has(params.threadId)) throw Object.assign(actionRequired('BUSY_ACTIVE'), {notSent:true, deliveryUncertain:false});
      const outcome = await provider.prepareTurn({taskId:task.taskId, spaceId:task.space || 'unbound',
        attemptId:randomUUID(), runId:randomUUID(), ...(task.waitId ? {waitId:task.waitId} : {})});
      if (outcome.kind !== 'ready') {
        const wait = providerWait(outcome);
        throw Object.assign(actionRequired(outcome.code || 'PROVIDER_UNAVAILABLE'),
          {notSent:true, deliveryUncertain:false, providerWait:wait, retryable:outcome.code === 'BUSY_ACTIVE'});
      }
      if (task.cancelRequested || disposed) { provider.releaseReserved(outcome.grant); throw Object.assign(actionRequired(), {notSent:true, deliveryUncertain:false}); }
      const row = {threadId:params.threadId, taskId:task.taskId, grant:outcome.grant, completed:new Set()}; runs.set(params.threadId, row);
      delete task.providerFailureCode;
      try {
        const result = await provider.dispatchTurn(outcome.grant, params); row.turnId = result.turn.id;
        delete task.waitId; task.waitingLimit = null;
        if (row.completed.has(row.turnId)) finishRun(row, row.turnId);
        return result;
      } catch (error) {
        if (error.deliveryUncertain === false) runs.delete(params.threadId);
        else {
          row.uncertain = true;
          for (const candidate of row.completed) if (finishRun(row, candidate)) break;
        }
        throw error;
      }
    }
    respond(...args) { return this.cli?.respond(...args); }
    dispose() {
      for (const [event, listener] of this.listeners) this.cli?.removeListener(event, listener);
      this.listeners = []; this.cli?.dispose(); this.cli = null;
    }
  }
  core = createSessionCore({paths:{storage:root}, workspaceState, settings, logger, clock,
    trusted:() => true, events:{changed:noop, sessionChanged:noop, treeChanged:noop, notify:noop, completed:noop},
    hasChat:() => true, isActive:() => false, activeSession:() => null, openChat:noop, loadSelected:noop,
    defaultDirectory:() => root, editorSelection:() => null, activateConnectionOwner:noop,
    resolveCli:resolveCli || (async () => findCli(settings('cliPath', ''))),
    checkCliUpdates:noop, cliCheckPending:() => true, acceptCli:noop, clearProjectFiles:noop,
    applyPendingMode:async () => {}, taskSessions:() => mcp?.tasks, createTransport:HeadlessTransport});
  core.connections.register('rundix.service', {id:'service-provider', label:'Service provider',
    authenticate:() => provider.authenticate(), configure:async () => {throw actionRequired('CLIENT_REQUIRED');}});
  if (core.connections.selection().id === 'local') core.connections.select('service-provider');
  const transport = {
    privateDirectory:directory => fs.mkdirSync(directory, {recursive:true, mode:0o700}),
    installLauncher:() => null, // Installed launcher is owned by the service installer, never the host.
    serve:async () => ({descriptor:null, dispose:noop}),
  };
  mcp = createMcpHost({core, storageRoot:root, trusted:() => true, settings, clock, transport,
    ui:{hasChat:() => false}, taskOptions, decorateAdapter:adapter => {
      adapter.cancelWait = task => provider.cancelWait({taskId:task.taskId, spaceId:task.space, waitId:task.waitId});
      const status = adapter.status;
      adapter.status = async task => {
        const value = await status(task);
        return task.providerFailureCode ? {...value, failed:true, answerUnknown:!value.done,
          error:'action_required: Open companion connection settings and reconnect.', progress:'Provider action required'} : value;
      };
      return decorateAdapter ? decorateAdapter(adapter) : adapter;
    }});
  provider.on('actionRequired', ({code, turns}) => {
    if (disposed) return;
    for (const {taskId, turnLeaseId} of turns) {
      const row = [...runs.values()].find(value => value.taskId === taskId && value.grant.leaseId === turnLeaseId);
      const task = row && mcp.tasks.tasks.get(taskId);
      if (!task) continue;
      task.providerFailureCode = code; task.state = 'error'; task.recoveryRequired = true;
      task.error = 'action_required: Open companion connection settings and reconnect.';
      task.progress = 'Provider action required'; mcp.tasks.save(task);
    }
  });
  try { await mcp.start(); } catch (error) { core.state.disposed = true; throw error; }
  logger({code:'service_started'});
  return {core, mcp, provider, settings, logger,
    busy:() => !disposed && (provider.busy || [...mcp.tasks.tasks.values()].some(task => !['completed', 'error', 'cancelled'].includes(task.state) || task.recoveryRequired)),
    async dispose() {
      if (disposed) return;
      if (provider.busy || [...mcp.tasks.tasks.values()].some(task => !['completed', 'error', 'cancelled'].includes(task.state) || task.recoveryRequired))
        throw Object.assign(Error('Service has unfinished tasks.'), {code:'service_busy'});
      await provider.dispose();
      disposed = true; core.state.disposed = true; core.state.server?.dispose(); mcp.dispose(); logger({code:'service_stopped'});
    },
  };
}
module.exports = {createHeadlessHost, plainSettings, boundedLogger, providerWait};
