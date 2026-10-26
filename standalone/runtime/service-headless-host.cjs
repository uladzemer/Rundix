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
    'provider_admission_ready','provider_admission_failed','provider_admission_auth_required','provider_account_refresh_deferred',
      'service_start_failed','task_directory_busy','task_directory_reserved','task_directory_unavailable','turn_outcome']);
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
        ...(code==='turn_outcome'?{outcome:require('./turn-diagnostics.cjs').safeOutcome(input?.outcome)}:{}),
        ...(code==='service_start_failed'&&/^[A-Za-z0-9_]{1,40}$/.test(input?.errorCode)?{errorCode:input.errorCode}:{}),
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
  // thread/start parameters by thread, to replace a thread that never ran a turn.
  const threadStarts = new Map();
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
        const task=row && mcp.tasks.tasks.get(row.taskId);
        if(task)task.lastActivityAt=clock.now();
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
        try {
          const result=await ready(()=>this.cli.request(method, params, timeoutMs));
          if(method==='thread/start' && result?.thread?.id)threadStarts.set(result.thread.id,params);
          return result;
        }
        catch(error) {logger({code:error?.reason==='connection_changed'?'cli_read_binding_changed':'cli_read_failed',method,providerCode:error?.code});throw error;}
      }
      const task = taskForThread(params.threadId);
      if (!task || runs.has(params.threadId)) throw Object.assign(actionRequired('BUSY_ACTIVE'), {notSent:true, deliveryUncertain:false});
      // Persist the thread before any admission/reconnect; task.chatId may lag
      // the already durable session after a crash before turn/start's ACK.
      task.chatId=params.threadId;task.deliveryPhase='preparing';mcp.tasks.save(task);
      if(task.limitContinuation?.state==='pending' && task.nextInput===recovery.CONTINUE && (recovery.continuationBlocked(task) || recovery.continuationNotBefore(task)>clock.now()))
        throw Object.assign(actionRequired('BUSY_ACTIVE'),{notSent:true,deliveryUncertain:false,providerWait:{resetAt:null,reason:'exhausted',retryAfterMs:Math.max(60000,recovery.continuationNotBefore(task)-clock.now())}});
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
      // Admission consumes this wait even if its reserved child exits before
      // dispatch. A later retry must acquire a fresh wait, never a retired ID.
      delete task.waitId;
      try{remaining();}catch(error){provider.releaseReserved(outcome.grant);throw error;}
      if (task.cancelRequested || disposed) { provider.releaseReserved(outcome.grant); throw Object.assign(actionRequired(), {notSent:true, deliveryUncertain:false}); }
      const row = {threadId:params.threadId, taskId:task.taskId, grant:outcome.grant, completed:new Set()}; runs.set(params.threadId, row);
      delete task.providerFailureCode;
      try {
        if(generationBefore!==this.cli.binding?.appServerGeneration) {
          // Rollouts survive account changes; the new app-server must load the
          // thread before dispatch, even if it was created by the old child.
          const session=core.sessions.get(task.sessionKey),original=params.threadId;
          try {
            await this.cli.request('thread/read',{threadId:original,includeTurns:false},30000);
            await this.cli.request('thread/resume',await core.resumeOptions(session,original),30000);
          } catch(error) {
            // Codex writes a rollout only after the first turn, so a thread that
            // never ran cannot be loaded by the new app-server. Nothing was sent:
            // replace the empty thread on this generation and dispatch there.
            const startParams=threadStarts.get(original);
            if(!startParams || session?.id!==original || session.lastStartedTurnId || (session.items||[]).length)throw error;
            const started=await this.cli.request('thread/start',startParams,30000);
            const replacement=started?.thread?.id;
            if(!replacement)throw error;
            threadStarts.delete(original);threadStarts.set(replacement,startParams);
            session.id=replacement;session.cwd=started.thread.cwd || session.cwd;
            // The in-flight send's leases move with the id, atomically with it.
            const lease=core.turnLeases.get(original);
            if(lease){core.turnLeases.delete(original);core.turnLeases.set(replacement,lease);}
            runs.delete(original);row.threadId=replacement;runs.set(replacement,row);
            params.threadId=replacement;task.chatId=replacement;
          }
          for(const session of core.sessions.values())session.loaded=false;
        }
        if(row.exited || !this.cli)throw Object.assign(Error('CLI changed before dispatch.'),{notSent:true,deliveryUncertain:false});
        task.deliveryPhase='dispatching';
        task.queuedRecoveryInput=false;
        task.lastActivityAt=clock.now();
        if(task.limitContinuation?.state==='pending' && task.nextInput===recovery.CONTINUE){
          task.autoLimit={consecutive:(task.autoLimit?.consecutive || 0)+1,lastSentAt:clock.now()};
          task.limitContinuation.state='dispatching';
        }
        mcp.tasks.save(task);
        dispatched();
        const result = await provider.dispatchTurn(outcome.grant, params); row.turnId = result.turn.id;
        const session=core.sessions.get(task.sessionKey);
        if(session)session.cliGeneration=this.cli.binding?.appServerGeneration;
        task.deliveryPhase='confirmed';task.needsReconcile=false;task.lastStatusReadAt=clock.now();
        if(task.limitContinuation?.state==='dispatching') {
          task.limitContinuation.state='delivered';task.limitContinuation.turnId=result.turn.id;
        }
        delete task.waitId; task.waitingLimit = null;
        if (row.completed.has(row.turnId)) finishRun(row, row.turnId);
        return result;
      } catch (error) {
        if(task.deliveryPhase==='preparing') {
          if(!row.exited)try{provider.releaseReserved(outcome.grant);}catch{}
          runs.delete(params.threadId);
          throw Object.assign(error,{notSent:true,deliveryUncertain:false,retryable:true});
        }
        if(row.exited)throw Object.assign(error,{confirmedCliExit:true,deliveryUncertain:false});
        if (error.deliveryUncertain === false) {
          // A definite refusal sent nothing: the same continuation may be retried.
          task.deliveryPhase='preparing';
          if(task.limitContinuation?.state==='dispatching'){task.limitContinuation.state='pending';task.autoLimit.consecutive=Math.max(0,task.autoLimit.consecutive-1);}
          runs.delete(params.threadId);
        }
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
    turnDiagnostic:outcome=>logger({code:'turn_outcome',outcome}),
    deferProviderNotifications:true,serviceMode:true,
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
    ui:{hasChat:() => false}, taskOptions:{now:()=>clock.now(),...taskOptions,archiveLog:logger}, decorateAdapter:adapter => {
      const start=adapter.start;
      adapter.readinessBudget=true;
      adapter.limitRecovery=true;
      adapter.start=(task,input,checkpoint=()=>{})=>attempt(task,checkpoint,()=>start(task,input,checkpoint));
      const assertConnection=adapter.assertConnection;
      adapter.assertConnection=(...args)=>{settings.assertValid();return assertConnection(...args);};
      adapter.cancelWait = task => provider.cancelWait({taskId:task.taskId, spaceId:task.space, waitId:task.waitId});
      adapter.status=require('./service-task-status.cjs').createTaskStatus({core,provider,now:()=>clock.now(),status:adapter.status,finishRun,runs});
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
    if(task.deliveryPhase==='preparing') {
      if(task.limitContinuation?.state==='pending'){task.waitId ||= randomUUID();recovery.enterLimitWait(task,clock.now());}
      else {task.state='queued';task.recoveryRequired=false;task.needsReconcile=false;task.progress='CLI changed before dispatch; retry queued';}
      mcp.tasks.save(task);mcp.tasks.schedule();return;
    }
    task.state='error';task.error='Execution stopped after confirmed CLI exit. Continue explicitly after checking the chat.';
    task.recoveryRequired=false;task.needsReconcile=true;
    if(row.limitTurnId && !task.cancelRequested && recovery.continueAfterLimit(task,row.limitTurnId)) {
      task.waitId=randomUUID();recovery.enterLimitWait(task,clock.now());
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
