// Durable task orchestration shared by plain MCP hosts.
const fs = require('node:fs');
const {randomUUID, createHash} = require('node:crypto');
const directories = require('./task-directory.cjs');
const inputRecovery = require('./mcp-input-recovery.cjs');
const active = new Set(['queued', 'running', 'waiting_approval', 'waiting_limit']);
const states = ['queued','running','waiting_approval','waiting_limit','completed','error','cancelled'];
const MAX_WAIT_SECONDS = 1500, MAX_PARALLEL = 5;
// Errors with a code are expected outcomes whose message is safe to return to the MCP client.
function fail(code, message) { return Object.assign(Error(message), {code}); }
function string(value, name, limit = 100000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw fail('invalid_argument', 'Invalid ' + name);
  return value;
}
function stable(value) { return value && typeof value==='object' ? Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])) : value; }
function fingerprint(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
// The stored flag also marks an in-flight turn for restart reconciliation; clients only see it once execution stopped.
function recoveryRequired(task) { return !!task.recoveryRequired && !['running','waiting_approval'].includes(task.state); }
// Queued and running tasks need no client action; every other state is worth waking a waiting client for.
function settled(task) { return !['queued','running','waiting_limit'].includes(task.state); }
function connected(adapter, task) {
  try { adapter.assertConnection(task); } catch (error) { if(error?.code==='SETTINGS_INVALID')throw error;throw fail('connection_unavailable', String(error?.message || 'The selected companion connection is unavailable.').slice(0,300)); }
}
async function available(adapter, task) {
  try {return await adapter.ensureConnection(task);}catch(error){if(error?.code==='SETTINGS_INVALID')throw error;throw fail('connection_unavailable','The selected companion is unavailable. Enable it and restore the selected connection before submitting.');}
}
function directoryFilter(value) {
  try { return directories.canonical(value); } catch { return process.platform==='win32' ? value.toLowerCase() : value; }
}
class McpTasks {
  constructor({store, adapter, directoryStore = store, maxParallel = () => 1, spaceOf = task => task.space, taskFilter = () => true, scope, signal, changed, maxStoredPerSpace=1000, keepClosed=100, archiveLog}) {
    // Optional task.space is absent for legacy/current-window tasks. No routing yet.
    this.spaceOf = spaceOf; this.taskFilter = taskFilter; this.scope = scope; this.signal = signal;
    this.changed = changed;
    this.store = store; this.directoryStore=directoryStore; this.adapter = adapter; this.maxParallel = maxParallel; this.tasks = new Map(); this.waiters = new Set(); this.starting = new Set(); this.launches = new Set(); this.operations = new Map(); this.executing = false; this.closed = false;
    if(scope){this.archive=new (require('./service-task-archive.cjs').TaskArchive)(store,{log:archiveLog});this.maxStoredPerSpace=maxStoredPerSpace;this.keepClosed=keepClosed;}
    for (const name of fs.readdirSync(store.directory).filter(n => /^mcp-task-[\w-]+\.json$/.test(n))) {
      const task = store.read('mcp-task', name.slice(9, -5));
      if (!task?.taskId || task.taskId!==name.slice(9,-5) || !Array.isArray(task.operations) || typeof task.projectDirectory!=='string' || !states.includes(task.state)) throw Error('MCP task storage is unreadable.');
      if(['running','waiting_approval'].includes(task.state) || task.recoveryRequired)task.needsReconcile=true;
      if(task.unknownAnswer) {task.state='error';task.recoveryRequired=true;task.needsReconcile=true;}
      for(const op of task.operations)if(op.outcome==='pending' && op.approvalId?.startsWith('async-question:'))op.outcome='unknown';
      inputRecovery.prune(task);
      this.tasks.set(task.taskId, task);
    }
    if(this.archive)for(const space of new Set([...this.tasks.values()].map(task=>task.space)))this.pruneClosed(space);
  }
  pruneClosed(space,retain=this.keepClosed){
    if(!this.archive)return;
    const closed=[...this.tasks.values()].filter(task=>task.space===space && task.closedAt && ['completed','cancelled','error'].includes(task.state) && !task.recoveryRequired && !this.starting.has(task.taskId))
      .sort((a,b)=>b.closedAt-a.closedAt || b.createdAt-a.createdAt || a.taskId.localeCompare(b.taskId));
    for(const task of closed.slice(retain)){this.archive.put(task);this.tasks.delete(task.taskId);}
  }
  ensureStorage(space,persist=false){
    if(!this.archive){if(this.tasks.size>=1000)throw fail('limit',persist?'Task storage limit reached.':'Task storage limit reached. Archive tasks while the bridge is stopped.');return;}
    const count=()=>[...this.tasks.values()].filter(task=>task.space===space).length;
    if(count()>=this.maxStoredPerSpace)this.pruneClosed(space,Math.max(0,[...this.tasks.values()].filter(task=>task.space===space && task.closedAt).length-(count()-this.maxStoredPerSpace+1)));
    if(count()>=this.maxStoredPerSpace)throw fail('limit','Task storage limit reached for this space. Close finished tasks first.');
  }
  save(task) {
    if(this.scope && task.state==='cancelled'){task.error=null;delete task.blockedReason;delete task.blockedUntil;}
    const restoring=this.archive && !this.tasks.has(task.taskId) && this.archive.get(task.taskId);
    const staysArchived=restoring && ['completed','cancelled','error'].includes(task.state) && !task.recoveryRequired;
    if(restoring && !staysArchived){this.ensureStorage(task.space);this.archive.restored(task);}
    task.updatedAt = Date.now(); task.revision = (task.revision || 0) + 1;
    if(staysArchived)this.archive.put(task);
    else {this.store.write('mcp-task', task.taskId, task);if(restoring)this.tasks.set(task.taskId,task);}
    for (const waiter of this.waiters) waiter.check();
    // Projection failures never change the durable execution outcome.
    try { this.changed?.(task); } catch {}
  }
  release(task) {
    directories.release(this.directoryStore,task.projectDirectory,task.taskId);
    // Best-effort cleanup must never change the durable task outcome, even on synchronous failure.
    try { void Promise.resolve(this.adapter.release?.(task)).catch(()=>{}); } catch {}
  }
  limit() { const value = Number(this.maxParallel()); return Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_PARALLEL) : 1; }
  visible(task) { return (!this.scope || this.scope() === this.spaceOf(task)) && this.taskFilter(this.spaceOf(task), task); }
  get(id) { const task = this.tasks.get(id) || this.archive?.get(id); if (!task || !this.visible(task)) throw fail('unknown_task', 'Unknown taskId'); return task; }
  view(task, brief = false, unsentAfter, fullRecovery=false) {
    const report = task.report;
    const reportFields = brief ? {reportSummary:report ? {
      source:report.source, resultPreview:report.result.slice(0,500) + (report.result.length > 500 ? '…' : ''),
      resultLength:report.result.length, changedFiles:report.changedFiles,
      checksCount:report.checks.length, remainingIssuesCount:report.remainingIssues.length,
    } : null} : {report:report || null};
    return JSON.parse(JSON.stringify({taskId:task.taskId, state:task.state, progress:task.progress,
      chatId:task.chatId || null, projectDirectory:task.projectDirectory, createdAt:task.createdAt,
      updatedAt:task.updatedAt, revision:task.revision || 0, accessMode:task.accessMode || null, ...reportFields, error:task.error || null,
      ...(this.scope || task.waitingLimit ? {waitingLimit:task.state === 'waiting_limit' ? task.waitingLimit : null} : {}),
      queuedContinuations:task.continuations?.length || 0,
      ...(fullRecovery?inputRecovery.page(task,unsentAfter):{unsentInputCount:task.unsentInputs?.length || 0}),
      recoveryRequired:recoveryRequired(task), pendingRequests:this.adapter.pending(task)}));
  }
  summary(task) {
    return JSON.parse(JSON.stringify({taskId:task.taskId, title:(task.description || '').slice(0,160), state:task.state,
      progress:task.progress, chatId:task.chatId || null, projectDirectory:task.projectDirectory, createdAt:task.createdAt,
      updatedAt:task.updatedAt, revision:task.revision || 0, hasReport:!!task.report, error:task.error || null,
      ...(this.scope || task.waitingLimit ? {waitingLimit:task.state === 'waiting_limit' ? task.waitingLimit : null} : {}),
      unsentInputCount:task.unsentInputs?.length || 0,
      recoveryRequired:recoveryRequired(task), pendingRequests:this.adapter.pending(task).length}));
  }
  operation(requestId, method, args, action) {
    string(requestId, 'requestId', 128);
    const hash = fingerprint([method, args]);
    const operationKey = this.scope ? this.scope() + '\0' + requestId : requestId;
    const inFlight=this.operations.get(operationKey);
    if(inFlight){if(inFlight.hash!==hash)throw fail('request_conflict','requestId was already used for different arguments.');return inFlight.promise;}
    for (const task of this.tasks.values()) {
      if (!this.visible(task)) continue;
      const found = task.operations.find(op => op.requestId === requestId);
      if (found) {
        if (found.hash !== hash) throw fail('request_conflict', 'requestId was already used for different arguments.');
        if (found.outcome === 'rejected') throw fail('approval_rejected', 'This approval response failed earlier. Check pendingRequests with get_task and answer again with a new requestId if it is still pending.');
        return this.view(task);
      }
    }
    if(this.archive){
      const archived=this.archive.request(this.scope(),requestId);
      if(archived){
        if(archived.operation.hash!==hash)throw fail('request_conflict','requestId was already used for different arguments.');
        if(archived.operation.outcome==='rejected')throw fail('approval_rejected','This approval response failed earlier.');
        return this.view(archived.task);
      }
    }
    const result=action({requestId, hash});
    if(result?.then){
      const promise=Promise.resolve(result).finally(()=>this.operations.delete(operationKey));
      this.operations.set(operationKey,{hash,promise});return promise;
    }
    return result;
  }
  list(args) {
    const limit = args.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('invalid_argument', 'Invalid limit');
    if (args.state !== undefined && !states.includes(args.state)) throw fail('invalid_argument', 'Invalid state');
    let after = null;
    if (args.cursor !== undefined) {
      const match = /^(\d{1,16}):([\w-]{1,64})$/.exec(Buffer.from(string(args.cursor, 'cursor', 200), 'base64url').toString());
      if (!match) throw fail('invalid_argument', 'Invalid cursor');
      after = {createdAt:Number(match[1]), taskId:match[2]};
    }
    const directory = args.projectDirectory === undefined ? null : directoryFilter(string(args.projectDirectory, 'projectDirectory', 4096));
    // Creation order keeps pages stable while active tasks keep updating.
    const order = (a,b) => (b.createdAt-a.createdAt) || (a.taskId<b.taskId?-1:a.taskId>b.taskId?1:0);
    const matches = [...this.tasks.values()].filter(t => this.visible(t) && (!args.state || t.state===args.state) && (!directory || t.projectDirectory===directory))
      .sort(order).filter(t => !after || order(t, after) > 0);
    const page = matches.slice(0, limit), last = page[page.length-1];
    return {tasks:page.map(t=>this.summary(t)), nextCursor:matches.length>limit ? Buffer.from(last.createdAt+':'+last.taskId).toString('base64url') : null};
  }
  checkpointDelay(tasks,deadline) {
    const now=Date.now();
    const future=tasks.filter(t=>t.state==='waiting_limit' && t.waitingLimit?.resetAt>now).map(t=>t.waitingLimit.resetAt);
    return Math.max(1,Math.min(deadline,...future)-now);
  }
  wait(args) {
    let task = this.get(args.taskId);
    const owner=this.spaceOf(task);
    const refresh=()=>{if(this.archive){const current=this.tasks.get(args.taskId)||this.archive.get(args.taskId);if(!current || this.spaceOf(current)!==owner)throw fail('unknown_task','Unknown taskId');task=current;}};
    if (args.brief !== undefined && typeof args.brief !== 'boolean') throw fail('invalid_argument', 'Invalid brief');
    const seconds = args.waitSeconds ?? 600, after = args.afterRevision;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_SECONDS) throw fail('invalid_argument', 'Invalid waitSeconds');
    if (after !== undefined && (!Number.isInteger(after) || after < 0)) throw fail('invalid_argument', 'Invalid afterRevision');
    const ready = () => {refresh();return settled(task) && (after === undefined || (task.revision || 0) > after);};
    if (ready() || this.closed) return {...this.view(task, args.brief), timedOut:false};
    return new Promise((resolve,reject) => {
      const signal=this.signal?.();
      const finish = (timedOut,error) => { clearTimeout(timer); signal?.removeEventListener('abort',abort); this.waiters.delete(waiter); try{if(error)throw error;refresh();resolve({...this.view(task, args.brief), timedOut});}catch(failure){reject(failure);} };
      const abort=()=>finish(true);
      const waiter = {check:()=>{try{if (ready()) finish(false);}catch(error){finish(false,error);}}, close:()=>finish(true)};
      let timer;
      const deadline=this.scope?Date.now()+seconds*1000:null;
      const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>finish(true),this.scope?this.checkpointDelay([task],deadline):seconds*1000);};
      const check=waiter.check;waiter.check=()=>{check();if(this.scope && this.waiters.has(waiter))arm();};
      this.waiters.add(waiter);arm();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
  }
  // Wakes on the first of several tasks that needs attention, so a client running tasks in parallel waits once.
  waitAny(args) {
    if (!Array.isArray(args.taskIds) || !args.taskIds.length || args.taskIds.length > 50 || new Set(args.taskIds).size !== args.taskIds.length) throw fail('invalid_argument', 'Invalid taskIds');
    if (args.brief !== undefined && typeof args.brief !== 'boolean') throw fail('invalid_argument', 'Invalid brief');
    const seconds = args.waitSeconds ?? 600;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_SECONDS) throw fail('invalid_argument', 'Invalid waitSeconds');
    const tasks = args.taskIds.map(id => this.get(id));
    const result = timedOut => {
      const value={settled:tasks.filter(settled).map(t=>this.view(t, args.brief)), waiting:tasks.filter(t=>!settled(t)).map(t=>t.taskId), timedOut,
        ...(this.scope ? {waitingLimits:tasks.filter(t=>t.state==='waiting_limit').map(t=>({taskId:t.taskId,...t.waitingLimit}))} : {})};
      if(Buffer.byteLength(JSON.stringify({result:value}))>1024*1024)throw fail('response_too_large','MCP response exceeds the 1 MiB transport limit. Retry with brief:true or fewer taskIds.');
      return value;
    };
    if (tasks.some(settled) || this.closed) return result(false);
    return new Promise((resolve,reject) => {
      const signal=this.signal?.();
      const finish = timedOut => { clearTimeout(timer); signal?.removeEventListener('abort',abort); this.waiters.delete(waiter); try{resolve(result(timedOut));}catch(error){reject(error);} };
      const abort=()=>finish(true);
      const waiter = {check:()=>{ if (tasks.some(settled)) finish(false); }, close:()=>finish(true)};
      let timer;
      const deadline=this.scope?Date.now()+seconds*1000:null;
      const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>finish(true),this.scope?this.checkpointDelay(tasks,deadline):seconds*1000);};
      const check=waiter.check;waiter.check=()=>{check();if(this.scope && this.waiters.has(waiter))arm();};
      this.waiters.add(waiter);arm();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
  }
  call(name, args = {}) {
    if (this.closed) throw fail('bridge_stopped', 'MCP executor is closed.');
    if (name === 'get_task') {
      if (args.brief !== undefined && typeof args.brief !== 'boolean') throw fail('invalid_argument', 'Invalid brief');
      const task=this.get(args.taskId);
      if(args.unsentAfter!==undefined && (typeof args.unsentAfter!=='string' || !task.unsentInputs?.some(row=>row.id===args.unsentAfter)))throw fail('invalid_argument','Invalid unsentAfter');
      return this.view(task, args.brief,args.unsentAfter,args.brief!==true);
    }
    if (name === 'wait_task') return this.wait(args);
    if (name === 'wait_tasks') return this.waitAny(args);
    if (name === 'reload_window') {
      if (args.force !== undefined && typeof args.force !== 'boolean') throw fail('invalid_argument', 'Invalid force');
      const running = [...this.tasks.values()].filter(t=>['running','waiting_approval'].includes(t.state)).length;
      if (running && !args.force) throw fail('task_active', running+' MCP task(s) are running; wait for them, or pass force:true (interrupted turns then need recovery).');
      return Promise.resolve(this.adapter.reloadWindow?.(args.force === true)).then(()=>({reloading:true}));
    }
    if (name === 'list_models') return Promise.resolve(this.adapter.models?.() ?? []).then(models=>({models}));
    if (name === 'close_task') {
      const task = this.get(args.taskId);
      if (!['completed','cancelled','error'].includes(task.state) || recoveryRequired(task)) throw fail('task_active', 'Only finished tasks can have their chat closed.');
      return Promise.resolve(this.adapter.closeChat?.(task)).then(closed=>{
        if(this.archive && this.tasks.has(task.taskId) && ['completed','cancelled','error'].includes(task.state) && !task.recoveryRequired){task.closedAt=Date.now();this.save(task);this.pruneClosed(task.space);}
        return {taskId:task.taskId, state:task.state, chatClosed:!!closed};},
        error=>{ throw fail('task_active', String(error?.message || 'The task chat could not be closed.').slice(0,200)); });
    }
    if (name === 'list_tasks') return this.list(args);
    if (name === 'submit_task') return this.operation(args.requestId, name, args, op => {
      connected(this.adapter);
      string(args.description, 'description'); string(args.acceptanceCriteria, 'acceptanceCriteria', 20000);
      if (args.model !== undefined) string(args.model, 'model', 200);
      if (args.effort !== undefined) string(args.effort, 'effort', 40);
      this.ensureStorage(this.scope?.());
      let projectDirectory;
      try { projectDirectory = this.scope ? require('./service-space.cjs').canonical(args.projectDirectory) : directories.canonical(args.projectDirectory); }
      catch { throw fail('invalid_directory', 'projectDirectory must be an existing absolute directory.'); }
      const persist=connection=>{
      if(this.closed)throw fail('bridge_stopped','MCP executor is closed.');
      this.ensureStorage(this.scope?.(),true);
      const task = {taskId:randomUUID(), sessionKey:randomUUID(), state:'queued', progress:'Queued',
        projectDirectory, description:args.description,
        acceptanceCriteria:args.acceptanceCriteria, model:args.model, effort:args.effort,
        ...(this.scope ? {space:this.scope()} : {}), connection:connection || this.adapter.connection(), operations:[op], createdAt:Date.now()};
      this.save(task); this.tasks.set(task.taskId, task); this.schedule(); return this.view(task);
      };
      return this.adapter.ensureConnection?available(this.adapter).then(persist):persist();
    });
    if (this.scope && ['continue_task','cancel_task'].includes(name)) this.get(args.taskId);
    if (!['continue_task','cancel_task'].includes(name)) throw fail('invalid_argument', 'Unknown tool');
    return this.operation(args.requestId, name, args, op => {
      const task = this.get(args.taskId);
      if (task.operations.length >= 1000) throw fail('limit', 'Task operation limit reached.');
      if (name === 'continue_task') {
        if (args.approval) {
          if(task.unknownAnswer || recoveryRequired(task))throw fail('delivery_unknown','Previous delivery needs reconciliation. Inspect the chat and wait for recovery; do not resend the answer.');
          const pending = this.adapter.pending(task).find(p=>String(p.id)===String(args.approval.id));
          if (!pending || task.state !== 'waiting_approval') throw fail('approval_not_pending', 'Approval request is no longer pending.');
          // Durable intent first: a lost reply must never replay an approval.
          op.outcome='pending';op.approvalId=String(args.approval.id);
          if(op.approvalId.startsWith('async-question:'))task.unknownAnswer=op.approvalId;
          task.operations.push(op); this.save(task);
          return Promise.resolve().then(()=>this.adapter.answer(task, args.approval)).then(()=>{
            delete task.unknownAnswer;
            op.outcome='applied'; task.state='running'; task.progress='Approval response sent'; this.save(task); return this.view(task);
          }, error=>{
            if(error?.deliveryOutcome==='unknown'){
              op.outcome='unknown';task.state='error';task.recoveryRequired=true;task.needsReconcile=true;
              task.progress='Waiting to reconcile answer delivery';task.error='Answer delivery is unknown; input was not retried.';
              this.save(task);this.schedule();
              throw fail('delivery_unknown','Answer delivery could not be confirmed. Wait for reconciliation and inspect the chat; do not resend.');
            }
            delete task.unknownAnswer;
            op.outcome='rejected'; this.save(task);
            throw fail('approval_rejected', 'Approval response was rejected: ' + String(error?.message || 'unknown reason').slice(0,200));
          });
        }
        string(args.clarification, 'clarification');
        connected(this.adapter, task);
        if(this.archive)delete task.closedAt;
        if(active.has(task.state)) {
          task.continuations ||= [];
          if(task.continuations.length>=20)throw fail('limit', 'Too many queued continuations.');
          task.continuations.push(args.clarification);
        } else {task.nextInput=args.clarification; task.state='queued'; task.error=null; task.cancelRequested=false; delete task.waitId;task.waitingLimit=null;
          if(this.adapter.readinessBudget){delete task.serviceReadiness;task.readinessOrigin=Date.now();}}
        task.progress='Continuation queued';
      } else {
        // The active attempt is handled by start()/reconciliation; only queued
        // inputs are safe recovery here, never an in-flight nextInput.
        if(task.state==='queued' && !task.recoveryRequired && !this.starting.has(task.taskId) && task.nextInput)
          inputRecovery.remember(task,task.nextInput);
        for(const text of task.continuations || [])inputRecovery.remember(task,text);
        // Record no-op cancellations too, so a replayed request can never cancel a later turn.
        if (!active.has(task.state) && !task.recoveryRequired) { task.operations.push(op); this.save(task); return this.view(task); }
        task.cancelRequested=true;
        if(this.scope){task.error=null;delete task.blockedReason;delete task.blockedUntil;}
        task.continuations=[];
        if (['queued','waiting_limit'].includes(task.state) && !task.recoveryRequired) {
          task.waitingLimit=null;
          task.state='cancelled'; task.progress='Cancelled before execution';
          this.release(task);
        } else { task.state='running';task.progress='Cancellation requested'; }
      }
      task.operations.push(op); this.save(task);
      if (name === 'cancel_task' && task.state === 'cancelled' && task.waitId) void Promise.resolve(this.adapter.cancelWait?.(task)).catch(()=>{});
      if (name === 'cancel_task' && task.state !== 'cancelled') {
        void Promise.resolve(this.adapter.cancel(task)).catch(()=>{task.error='Cancellation could not be confirmed; query task again.';this.save(task);});
      }
      this.schedule(); return this.view(task);
    });
  }
  schedule(delay = 50) {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(()=>{ this.scheduled=null; void this.tick().catch(()=>{}); }, delay);
    this.scheduled.unref?.();
  }
  // Polling saves only real changes, so revision and updatedAt mean "something happened".
  update(task, change) {
    // Pending request IDs count too: a new approval must wake waiters even when the state stays waiting_approval.
    const observed = () => JSON.stringify([task.state, task.progress, task.chatId, task.report, task.recoveryRequired, task.error, task.pendingIds]);
    const before = observed();
    change();
    if (observed() !== before) this.save(task);
  }
  // Blocked tasks are re-probed at most once a second, even while other tasks keep the scheduler busy.
  block(task, reason) { task.blockedUntil=Date.now()+1000; this.update(task, ()=>{ task.progress=reason; }); return 'blocked'; }
  async prepare(task) {
    // A throttled task whose recovered turn is still live keeps occupying its slot.
    if (task.blockedUntil > Date.now()) return task.liveRecovery ? 'stopped' : 'blocked';
    try { this.adapter.assertConnection(task); }
    catch { return this.block(task, 'Waiting for the selected companion connection; inspect the Rundix MCP panel'); }
    // Recovery only observes the old chat; it never resubmits its old input.
    if (task.recoveryRequired) {
      let status;
      try { status = await this.adapter.status(task); } catch { return this.block(task, 'Previous chat status unavailable; restore the connection'); }
      if (this.closed) return 'stopped';
      if (!status.done) {
        if(status.pending && !task.unknownAnswer){task.state='waiting_approval';task.progress=status.progress || 'Waiting for approval';this.save(task);return 'stopped';}
        if (task.cancelRequested) { task.state='running'; task.progress='Cancellation requested'; this.save(task); return 'stopped'; }
        // A live recovered turn still occupies a slot, even before it is observed again.
        task.liveRecovery=true; this.block(task, 'Waiting for the previous turn of this chat to finish'); return 'stopped';
      }
      task.recoveryRequired=false; task.liveRecovery=false;
    }
    if (task.cancelRequested) {
      task.state='cancelled'; task.progress='Cancellation confirmed';
      this.release(task); this.save(task); return 'handled';
    }
    try { directories.reserve(this.directoryStore,task.projectDirectory,task.taskId); }
    catch (error) { return this.block(task, /reserved/.test(error.message) ? 'Waiting: project directory is used by another MCP task or chat' : 'Waiting: project directory is unavailable'); }
    return 'ready';
  }
  async tick() {
    if (this.closed || this.executing) return;
    this.executing=true;
    try {
      for (const task of this.tasks.values()) {
        // A task still being started is owned by its start() call until that returns.
        if ((['running','waiting_approval'].includes(task.state) || task.state==='error' && task.recoveryRequired) && !this.starting.has(task.taskId)) {
          let status;
          const observedRevision=task.revision;
          try { status = await this.adapter.status(task); }
          catch { if (this.closed) return; if(this.scope && task.revision!==observedRevision)continue;task.state='error';task.recoveryRequired=true;task.needsReconcile=true;task.error='Chat status unavailable. Restore the connection and explicitly continue after inspecting the chat.';this.save(task);continue; }
          if (this.closed) return;
          if(this.scope && task.revision!==observedRevision)continue;
          this.update(task, ()=>{
            if(task.state==='error' && task.recoveryRequired && !status.answerUnknown)task.error=status.error || null;
            task.pendingIds=this.adapter.pending(task).map(r=>String(r.id));
            if (status.chatId) task.chatId=status.chatId;
            if(status.answerUnknown){task.state='error';task.recoveryRequired=true;task.progress=status.progress;}
            else if (status.done) {
              task.state=status.cancelled?'cancelled':status.failed?'error':'completed';
              task.progress='Turn finished'; task.report=status.report; task.recoveryRequired=false;
              if(task.state==='completed' && task.continuations?.length){task.nextInput=task.continuations.shift();task.state='queued';task.progress='Continuation queued';
                if(this.adapter.readinessBudget){delete task.serviceReadiness;task.readinessOrigin=Date.now();}}
              else this.release(task);
            } else { task.state=status.pending?'waiting_approval':'running'; task.progress=status.progress || task.progress; }
          });
        }
      }
      // Up to maxParallel turns run at once; directory leases keep one turn per project/worktree.
      // Ambiguous turns reserve capacity until observation proves they stopped, even if the last read failed.
      const counted = new Set([...this.tasks.values()].filter(t=>t.state==='queued' && t.recoveryRequired).map(t=>t.taskId));
      let capacity = this.limit() - [...this.tasks.values()].filter(t=>['running','waiting_approval'].includes(t.state) || t.state==='error' && t.recoveryRequired).length - counted.size;
      // A blocked task must not stall tasks for other directories; order within one directory is preserved.
      const blocked = new Set();
      for (const task of [...this.tasks.values()].filter(t=>t.state==='queued').sort((a,b)=>a.createdAt-b.createdAt)) {
        if (capacity <= 0 && !counted.has(task.taskId)) continue;
        if (blocked.has(task.projectDirectory)) continue;
        const outcome = await this.prepare(task);
        // start() releases the fresh reservation itself if the executor closed meanwhile.
        // Starting can wait for a quota reset; it runs alongside the scheduler so other tasks keep being observed.
        if (outcome === 'ready') { if (!counted.has(task.taskId)) capacity--; this.launch(task); continue; }
        if (this.closed) return;
        // A live recovered turn or a pending cancellation still occupies a slot.
        if (outcome === 'stopped') { if (!counted.has(task.taskId)) capacity--; blocked.add(task.projectDirectory); continue; }
        if (outcome === 'blocked') { blocked.add(task.projectDirectory); continue; }
        if(counted.has(task.taskId))capacity++;
      }
    } finally {
      this.executing=false;
      // Only blocked queued tasks remain: retry once a second instead of re-probing every 50 ms.
      const tasks=[...this.tasks.values()];
      if (tasks.some(t=>['running','waiting_approval'].includes(t.state))) this.schedule();
      else if (tasks.some(t=>t.state==='queued' || t.state==='error' && t.recoveryRequired)) this.schedule(1000);
    }
  }
  idle() { return Promise.all([...this.launches]); }
  launch(task) {
    this.starting.add(task.taskId);
    const started = this.start(task).catch(()=>{}).finally(()=>{ this.starting.delete(task.taskId); this.schedule(); });
    this.launches.add(started); void started.finally(()=>this.launches.delete(started));
  }
  async start(task) {
    if (this.closed) { directories.release(this.directoryStore,task.projectDirectory,task.taskId); return; }
    const input=task.nextInput || task.description + '\n\nAcceptance criteria:\n' + task.acceptanceCriteria +
      '\n\nFinish with a report containing result, changed files, checks performed and remaining issues.';
    // Once another attempt is intended, this text is no longer proven unsent.
    // nextInput remains durable; a definite refusal below restores recovery.
    inputRecovery.delivered(task,input);
    task.state='running'; task.progress='Starting existing Codex executor'; task.recoveryRequired=true; task.awaitingPreparation=false; this.save(task);
    try {
      await this.adapter.start(task,input,()=>this.save(task));
      inputRecovery.delivered(task,input);
      delete task.nextInput;
      task.chatId=this.adapter.chatId(task); this.save(task);
    } catch (error) {
      if(this.scope && error?.confirmedCliExit) {
        task.state='error';task.recoveryRequired=false;task.needsReconcile=false;
        task.error='Execution stopped after confirmed CLI exit. Continue explicitly after checking the chat.';
        this.release(task);this.save(task);return;
      }
      if(error?.providerWait && !task.cancelRequested){
        inputRecovery.remember(task,input); task.nextInput=input;
        task.state='waiting_limit';task.recoveryRequired=false;task.needsReconcile=false;
        task.waitId=error.providerWait.waitId || task.waitId || randomUUID();
        task.waitingLimit={resetAt:error.providerWait.resetAt,reason:error.providerWait.reason};
        task.chatId=this.adapter.chatId(task);
        task.nextCheckAt=Date.now() + (error.providerWait.retryAfterMs || 0);task.retryNotBefore=task.nextCheckAt;
        task.progress='Waiting for provider availability';task.error=null;this.save(task);return;
      }
      if(error?.reason==='action_required' && error?.notSent && !error.retryable && !task.cancelRequested){
        inputRecovery.remember(task,input); task.state='error';task.recoveryRequired=false;task.needsReconcile=false;
        task.error='action_required: Open companion connection settings and reconnect.';task.progress='Provider action required';
        this.release(task);this.save(task);return;
      }
      if(task.cancelRequested && (task.awaitingPreparation || error?.retryable || error?.notSent)){
        inputRecovery.remember(task,input);
        task.state='cancelled';task.recoveryRequired=false;task.progress='Cancelled before model execution';
        this.release(task);this.save(task);return;
      }
      // Nothing was sent (another turn holds the connection or credentials): wait and start again.
      if(error?.retryable && !task.cancelRequested){
        task.state='queued';task.recoveryRequired=false;task.progress=error.serviceReadiness ? error.progress : 'Waiting to start: the connection is busy with another turn';
        task.blockedUntil=Date.now()+5000;directories.release(this.directoryStore,task.projectDirectory,task.taskId);this.save(task);return;
      }
      if(error?.notSent){
        inputRecovery.remember(task,input);
        task.state='error';task.recoveryRequired=false;task.needsReconcile=false;
        task.progress='Execution refused before sending';task.error='Execution did not start. Check the connection and chat before continuing.';
        this.release(task);this.save(task);return;
      }
      task.state='error'; task.progress='Execution stopped'; task.error='Execution could not be confirmed. Inspect the chat before continuing; input was not retried.';
      task.needsReconcile=true;
      this.save(task);
    }
  }
  dispose() { this.closed=true; clearTimeout(this.scheduled); for (const waiter of [...this.waiters]) waiter.close(); }
}
module.exports={McpTasks, recoveryRequired, MAX_WAIT_SECONDS};
