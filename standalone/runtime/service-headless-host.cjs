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
const {startupFailure,attempt,ready,remaining,dispatched}=require('./service-readiness.cjs');
const recovery = require('./task-recovery.cjs');
function boundedLogger(root) {
  const directory = path.join(root, 'diagnostics'); fs.mkdirSync(directory, {recursive:true, mode:0o700});
  const file = index => path.join(directory, 'service-' + index + '.log');
  const codes = new Set(['host_error', 'cli_stopped', 'service_started', 'service_stopped', 'idle_exit_failed', 'provider_unavailable','archive_record_corrupt','archive_record_unavailable','archive_index_corrupt','archive_index_unavailable',
    'provider_auth_started','provider_auth_ready','provider_auth_failed','cli_read_binding_changed','cli_read_failed',
    'provider_admission_ready','provider_admission_failed','provider_admission_auth_required','provider_account_refresh_deferred']);
  const methods=new Set(['thread/read','thread/resume','thread/turns/list','thread/items/list','thread/unsubscribe',
    'account/read','account/rateLimits/read','model/list','config/read','thread/start','thread/name/set','turn/interrupt']);
  const providerCodes=new Set([...require('./service-provider-contract.cjs').UNAVAILABLE_CODES,
    'SERVICE_READINESS_EXHAUSTED','PROVIDER_UNAVAILABLE','PROVIDER_PROTOCOL_INVALID','rejected','connection_unavailable']);
  return input => {
    const code = codes.has(input?.code) ? input.code : 'host_error';
    try {
      if (fs.existsSync(file(0)) && fs.statSync(file(0)).size >= 1024 * 1024) {
        try { fs.unlinkSync(file(2)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (fs.existsSync(file(1))) fs.renameSync(file(1), file(2));
        fs.renameSync(file(0), file(1));
      }
      fs.appendFileSync(file(0), JSON.stringify({at:Date.now(), code,
        ...(methods.has(input?.method)?{method:input.method}:{}),
        ...(providerCodes.has(input?.providerCode)?{providerCode:input.providerCode}:{})}) + '\n', {mode:0o600});
    } catch {} // Logging must never change send/recovery outcomes.
  };
}
function providerWait(outcome) {
  if (outcome.kind === 'waitUntil') return {waitId:outcome.waitId, resetAt:outcome.resetAt, reason:outcome.reason};
  const reason = {LIMITS_UNKNOWN:'limits_unknown', RESET_UNKNOWN:'reset_unknown', BUSY_ACTIVE:'active_turns'}[outcome.code];
  return reason ? {waitId:outcome.waitId, resetAt:null, reason, retryAfterMs:outcome.retryAfterMs || 0} : null;
}

async function createHeadlessHost({root, generation, providerOptions = {}, resolveCli, clock = {now:Date.now, setTimeout, clearTimeout},
  taskOptions = {}, decorateAdapter,onSessionChanged=()=>{}} = {}) {
  const settings = plainSettings(root), logger = boundedLogger(root);
  const kv = new SessionStore(path.join(root, 'state'));
  const workspaceState = {
    get(key, fallback) { return kv.read('value', createHash('sha256').update(key).digest('hex'))?.value ?? fallback; },
    async update(key, value) { kv.write('value', createHash('sha256').update(key).digest('hex'), {value}); },
  };
  const provider = new ServiceProvider({...providerOptions, serviceGeneration:generation, logger});
  let core, mcp, disposed = false, stopping = false;
  const coreLogger = input => logger(stopping && input === 'CLI stopped. Reconnect the provider.'
    ? {code:'cli_stopped'} : input);
  const runs = new Map();
  const noop = () => {};
  const taskForThread = threadId => {
    const session = [...core.sessions.values()].find(session => session.id === threadId);
    return session && [...mcp.tasks.tasks.values()].find(task => task.sessionKey === session.key);
  };
  function finishRun(row, turnId, reconciled=false) {
    if (row.turnId && row.turnId !== turnId || runs.get(row.threadId) !== row) return false;
    try { provider.terminal({turnLeaseId:row.grant.leaseId, taskId:row.taskId, runId:row.grant.runId, turnId, limitReached:row.limitTurnId===turnId, reconciled}); }
    catch (error) { if (error.code !== 'STALE_FENCE') logger({code:'host_error'}); return false; }
    row.turnId = turnId; runs.delete(row.threadId); return true;
  }
  class HeadlessTransport extends EventEmitter {
    constructor(options) { super(); this.options = options; this.executable = options.executable; this.listeners = []; this.handlesTurnAdmission = true; }
    async start() {
      settings.assertValid();
      try {await ready(()=>provider.start());}catch(error){throw startupFailure(error,'provider');}
      const cli = provider.cli || provider.createCli(this.options); this.cli = cli;
      const on = (event, handler) => { cli.on(event, handler); this.listeners.push([event, handler]); };
      on('notification', message => {
        if (this.cli !== cli || disposed) return;
        const row = runs.get(message.params?.threadId);
        if (row && message.params?.willRetry!==true && recovery.usageLimit(message.params?.error || message.params?.turn?.error)) {
          const turnId=message.params?.turn?.id || message.params?.turnId || row.turnId;
          if (turnId && (!row.turnId || row.turnId===turnId)) {
            try{provider.noteUsageLimit({turnLeaseId:row.grant.leaseId,turnId});}catch{logger({code:'host_error'});}
            row.limitTurnId=turnId;
            const task=mcp.tasks.tasks.get(row.taskId);
            if(task){task.exhaustedTurnId=turnId;mcp.tasks.save(task);}
          }
        }
        if (row && message.method === 'turn/completed') {
          const turnId = message.params?.turn?.id;
          if (typeof turnId === 'string') {
            if(message.params.turn.status==='completed' && row.limitTurnId===turnId) {
              try{provider.noteUsageLimit({turnLeaseId:row.grant.leaseId,turnId,limitReached:false});}catch{logger({code:'host_error'});}
              delete row.limitTurnId;
              const task=mcp.tasks.tasks.get(row.taskId);
              if(task?.exhaustedTurnId===turnId){delete task.exhaustedTurnId;mcp.tasks.save(task);}
            }
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
      on('disconnected', message => {
        // The driver owns child restart. Retired facades must stop receiving
        // notifications from a later child on the same ServiceAppServer object.
        for(const [event,listener] of this.listeners)cli.removeListener(event,listener);
        this.listeners=[];this.cli=null;
        this.emit('disconnected', message);
      });
      on('protocolError', message => this.emit('protocolError', message));
      try {return await ready(()=>cli.start());}catch(error){throw startupFailure(error,'cli');}
    }
    async request(method, params = {}, timeoutMs) {
      if (!this.cli || disposed) throw actionRequired('PROVIDER_UNAVAILABLE');
      if (method !== 'turn/start') {
        try {return await ready(()=>this.cli.request(method, params, timeoutMs));}
        catch(error) {logger({code:error?.reason==='connection_changed'?'cli_read_binding_changed':'cli_read_failed',method,providerCode:error?.code});throw error;}
      }
      const task = taskForThread(params.threadId);
      if (!task || runs.has(params.threadId)) throw Object.assign(actionRequired('BUSY_ACTIVE'), {notSent:true, deliveryUncertain:false});
      // Persist the thread before any admission/reconnect; task.chatId may lag
      // the already durable session after a crash before turn/start's ACK.
      task.chatId=params.threadId;task.deliveryPhase='preparing';mcp.tasks.save(task);
      const generationBefore=this.cli.binding?.appServerGeneration;
      let outcome;
      try {outcome = await provider.prepareTurn({taskId:task.taskId, spaceId:task.space || 'unbound',
        attemptId:randomUUID(), runId:randomUUID(), ...(task.waitId ? {waitId:task.waitId} : {})},{timeoutMs:remaining()});}
      catch(error) {logger({code:error?.code==='AUTH_REQUIRED'?'provider_admission_auth_required':'provider_admission_failed',providerCode:error?.code});throw Object.assign(startupFailure(error,'admission'),{notSent:true,deliveryUncertain:false});}
      if (outcome.kind !== 'ready') {
        logger({code:outcome.code==='AUTH_REQUIRED'?'provider_admission_auth_required':'provider_admission_failed'});
        const wait = providerWait(outcome);
        throw Object.assign(actionRequired(outcome.code || 'PROVIDER_UNAVAILABLE'),
          {notSent:true, deliveryUncertain:false, providerWait:wait, retryable:outcome.code === 'BUSY_ACTIVE'});
      }
      logger({code:'provider_admission_ready'});
      try{remaining();}catch(error){provider.releaseReserved(outcome.grant);throw error;}
      if (task.cancelRequested || disposed) { provider.releaseReserved(outcome.grant); throw Object.assign(actionRequired(), {notSent:true, deliveryUncertain:false}); }
      const row = {threadId:params.threadId, taskId:task.taskId, grant:outcome.grant, completed:new Set()}; runs.set(params.threadId, row);
      delete task.providerFailureCode;
      try {
        if(generationBefore!==this.cli.binding?.appServerGeneration) {
          // Rollouts survive account changes; the new app-server must load the
          // thread before dispatch, even if it was created by the old child.
          await this.cli.request('thread/read',{threadId:params.threadId,includeTurns:false},9000);
          await this.cli.request('thread/resume',{threadId:params.threadId,excludeTurns:true},9000);
          for(const session of core.sessions.values())session.loaded=false;
        }
        task.deliveryPhase='dispatching';
        if(task.limitContinuation?.state==='pending')task.limitContinuation.state='dispatching';
        mcp.tasks.save(task);
        dispatched();
        const result = await provider.dispatchTurn(outcome.grant, params); row.turnId = result.turn.id;
        const session=core.sessions.get(task.sessionKey);
        if(session)session.cliGeneration=this.cli.binding?.appServerGeneration;
        task.deliveryPhase='confirmed';
        if(task.limitContinuation?.state==='dispatching') {
          task.limitContinuation.state='delivered';task.limitContinuation.turnId=result.turn.id;
        }
        delete task.waitId; task.waitingLimit = null;
        if (row.completed.has(row.turnId)) finishRun(row, row.turnId);
        return result;
      } catch (error) {
        if(row.exited)throw Object.assign(error,{confirmedCliExit:true,deliveryUncertain:false});
        if(task.deliveryPhase==='preparing') {
          provider.releaseReserved(outcome.grant);runs.delete(params.threadId);
          throw Object.assign(error,{notSent:true,deliveryUncertain:false,retryable:true});
        }
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
  core = createSessionCore({paths:{storage:root}, workspaceState, settings, logger:coreLogger, clock,
    deferProviderNotifications:true,
    onDeferredProviderRefresh:()=>logger({code:'provider_account_refresh_deferred'}),
    trusted:() => true, events:{changed:noop, sessionChanged:onSessionChanged, treeChanged:noop, notify:noop, completed:noop},
    hasChat:() => true, isActive:() => false, activeSession:() => null, openChat:noop, loadSelected:noop,
    defaultDirectory:() => root, editorSelection:() => null, activateConnectionOwner:noop,
    resolveCli:resolveCli || (async () => findCli(settings('cliPath', ''))),
    checkCliUpdates:noop, cliCheckPending:() => true, acceptCli:noop, clearProjectFiles:noop,
    applyPendingMode:async () => {}, taskSessions:() => mcp?.tasks, createTransport:HeadlessTransport});
  core.connections.register('rundix.service', {id:'service-provider', label:'Service provider',
    authenticate:async () => {
      logger({code:'provider_auth_started'});
      try {const result=await ready(()=>provider.authenticate());logger({code:'provider_auth_ready'});return result;}
      catch(error) {logger({code:'provider_auth_failed'});throw startupFailure(error,'authentication');}
    }, configure:async () => {throw actionRequired('CLIENT_REQUIRED');}});
  if (core.connections.selection().id === 'local') core.connections.select('service-provider');
  provider.on('cliGenerationChanged',()=>{
    for(const session of core.sessions.values())session.loaded=false;
  });
  const transport = {
    privateDirectory:directory => fs.mkdirSync(directory, {recursive:true, mode:0o700}),
    installLauncher:() => null, // Installed launcher is owned by the service installer, never the host.
    serve:async () => ({descriptor:null, dispose:noop}),
  };
  mcp = createMcpHost({core, storageRoot:root, trusted:() => true, settings:(key,fallback)=>{
      // The scheduler may idle without a snapshot; every task admission stays gated.
      if(key==='mcpMaxParallelTasks'){try{return settings(key,fallback);}catch{return 1;}}
      return settings(key,fallback);
    }, clock, transport,
    ui:{hasChat:() => false}, taskOptions:{...taskOptions,archiveLog:logger}, decorateAdapter:adapter => {
      const start=adapter.start;
      adapter.readinessBudget=true;
      adapter.limitRecovery=true;
      adapter.start=(task,input,checkpoint=()=>{})=>attempt(task,checkpoint,()=>start(task,input,checkpoint));
      const assertConnection=adapter.assertConnection;
      adapter.assertConnection=(...args)=>{settings.assertValid();return assertConnection(...args);};
      adapter.cancelWait = task => provider.cancelWait({taskId:task.taskId, spaceId:task.space, waitId:task.waitId});
      const status = adapter.status;
      adapter.status = async task => {
        const session=core.sessions.get(task.sessionKey);
        const saved=session || core.store.session(task.sessionKey);
        if(!task.chatId && !saved?.id && task.deliveryPhase!=='dispatching')
          return {done:true,failed:true,cancelled:!!task.cancelRequested,progress:'Execution did not start'};
        const generation=provider.cli?.binding?.appServerGeneration;
        if(session && session.cliGeneration!==generation)session.loaded=false;
        if(session?.busy && Date.now()-(task.lastStatusReadAt || 0)>=15000) {
          session.loaded=false;task.needsReconcile=true;
        }
        if(task.needsReconcile && saved?.id) {
          await core.connect();
          const result=await core.state.server.request('thread/read',{threadId:saved.id,includeTurns:true},9000);
          const last=result.thread?.turns?.at(-1);
          if(last && recovery.usageLimit(last.error))task.exhaustedTurnId=last.id;
          task.lastStatusReadAt=Date.now();
        }
        const value = await status(task);
        const current=core.sessions.get(task.sessionKey);
        if(current)current.cliGeneration=provider.cli?.binding?.appServerGeneration;
        // A typed terminal for a lost ACK must release the corresponding driver
        // grant too, otherwise every later admission sees BUSY_ACTIVE forever.
        const row=runs.get(value.chatId);
        if(value.done && row && value.finishedTurnId)finishRun(row,value.finishedTurnId,true);
        if(value.done && task.exhaustedTurnId && (!task.turnId || task.turnId===task.exhaustedTurnId))
          return {...value,exhaustedTurnId:task.exhaustedTurnId};
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
  provider.on('turnExited', ({taskId,turnLeaseId}) => {
    try {
    const row=[...runs.values()].find(value=>value.taskId===taskId && value.grant.leaseId===turnLeaseId);
    if(!row)return;
    row.exited=true;runs.delete(row.threadId);
    const task=mcp.tasks?.tasks.get(taskId);if(!task)return;
    task.state='error';task.error='Execution stopped after confirmed CLI exit. Continue explicitly after checking the chat.';
    task.recoveryRequired=false;task.needsReconcile=true;
    if(row.limitTurnId && !task.cancelRequested && recovery.continueAfterLimit(task,row.limitTurnId)) {
      task.state='waiting_limit';task.waitId=randomUUID();task.waitingLimit={resetAt:null,reason:'exhausted'};
      task.nextCheckAt=Date.now();task.retryNotBefore=0;task.error=null;
      delete task.serviceReadiness;task.readinessAfterWait=true;
      task.progress='Turn ended by usage limit; waiting for provider';
    }
    const session=core.sessions.get(task.sessionKey);if(session){session.loaded=false;session.busy=false;session.turnId=null;}
    try{mcp.tasks.release(task);}catch{logger({code:'host_error'});}
    mcp.tasks.save(task);
    mcp.tasks.schedule();
    }catch{logger({code:'host_error'});}
  });
  try { await mcp.start(); } catch (error) { core.state.disposed = true; throw error; }
  logger({code:'service_started'});
  return {core, mcp, provider, settings, logger,
    busy:() => !disposed && (provider.busy || [...mcp.tasks.tasks.values()].some(task => !['completed', 'error', 'cancelled'].includes(task.state) || task.recoveryRequired)),
    async dispose({force=false} = {}) {
      if (disposed) return;
      if (!force && (provider.busy || [...mcp.tasks.tasks.values()].some(task => !['completed', 'error', 'cancelled'].includes(task.state) || task.recoveryRequired)))
        throw Object.assign(Error('Service has unfinished tasks.'), {code:'service_busy'});
      stopping = true;
      try{await provider.dispose('serviceShutdown',{force});}catch(error){if(!force)throw error;logger({code:'host_error'});}
      finally{stopping = false;}
      disposed = true; core.state.disposed = true; core.state.server?.dispose(); mcp.dispose(); logger({code:'service_stopped'});
    },
  };
}
module.exports = {createHeadlessHost, plainSettings, boundedLogger, providerWait};
