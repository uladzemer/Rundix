// Durable task orchestration. The adapter is the existing extension executor.
const fs = require('node:fs');
const {randomUUID, createHash} = require('node:crypto');
const directories = require('./task-directory.cjs');
const active = new Set(['queued', 'running', 'waiting_approval']);
const states = ['queued','running','waiting_approval','completed','error','cancelled'];
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
function settled(task) { return !['queued','running'].includes(task.state); }
function connected(adapter, task) {
  try { adapter.assertConnection(task); } catch (error) { throw fail('connection_unavailable', String(error?.message || 'The selected companion connection is unavailable.').slice(0,300)); }
}
function directoryFilter(value) {
  try { return directories.canonical(value); } catch { return process.platform==='win32' ? value.toLowerCase() : value; }
}
class McpTasks {
  constructor({store, adapter, directoryStore = store, maxParallel = () => 1}) {
    this.store = store; this.directoryStore=directoryStore; this.adapter = adapter; this.maxParallel = maxParallel; this.tasks = new Map(); this.waiters = new Set(); this.starting = new Set(); this.launches = new Set(); this.executing = false; this.closed = false;
    for (const name of fs.readdirSync(store.directory).filter(n => /^mcp-task-[\w-]+\.json$/.test(n))) {
      const task = store.read('mcp-task', name.slice(9, -5));
      if (!task?.taskId || task.taskId!==name.slice(9,-5) || !Array.isArray(task.operations) || typeof task.projectDirectory!=='string' || !states.includes(task.state)) throw Error('MCP task storage is unreadable.');
      if(['running','waiting_approval'].includes(task.state) || task.recoveryRequired)task.needsReconcile=true;
      this.tasks.set(task.taskId, task);
    }
  }
  save(task) {
    task.updatedAt = Date.now(); task.revision = (task.revision || 0) + 1;
    this.store.write('mcp-task', task.taskId, task);
    for (const waiter of this.waiters) waiter.check();
  }
  release(task) {
    directories.release(this.directoryStore,task.projectDirectory,task.taskId);
    // Best-effort cleanup must never change the durable task outcome, even on synchronous failure.
    try { void Promise.resolve(this.adapter.release?.(task)).catch(()=>{}); } catch {}
  }
  limit() { const value = Number(this.maxParallel()); return Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_PARALLEL) : 1; }
  get(id) { const task = this.tasks.get(id); if (!task) throw fail('unknown_task', 'Unknown taskId'); return task; }
  view(task, brief = false) {
    const report = task.report;
    const reportFields = brief ? {reportSummary:report ? {
      source:report.source, resultPreview:report.result.slice(0,500) + (report.result.length > 500 ? '…' : ''),
      resultLength:report.result.length, changedFiles:report.changedFiles,
      checksCount:report.checks.length, remainingIssuesCount:report.remainingIssues.length,
    } : null} : {report:report || null};
    return JSON.parse(JSON.stringify({taskId:task.taskId, state:task.state, progress:task.progress,
      chatId:task.chatId || null, projectDirectory:task.projectDirectory, createdAt:task.createdAt,
      updatedAt:task.updatedAt, revision:task.revision || 0, accessMode:task.accessMode || null, ...reportFields, error:task.error || null,
      queuedContinuations:task.continuations?.length || 0,
      recoveryRequired:recoveryRequired(task), pendingRequests:this.adapter.pending(task)}));
  }
  summary(task) {
    return JSON.parse(JSON.stringify({taskId:task.taskId, title:(task.description || '').slice(0,160), state:task.state,
      progress:task.progress, chatId:task.chatId || null, projectDirectory:task.projectDirectory, createdAt:task.createdAt,
      updatedAt:task.updatedAt, revision:task.revision || 0, hasReport:!!task.report, error:task.error || null,
      recoveryRequired:recoveryRequired(task), pendingRequests:this.adapter.pending(task).length}));
  }
  operation(requestId, method, args, action) {
    string(requestId, 'requestId', 128);
    const hash = fingerprint([method, args]);
    for (const task of this.tasks.values()) {
      const found = task.operations.find(op => op.requestId === requestId);
      if (found) {
        if (found.hash !== hash) throw fail('request_conflict', 'requestId was already used for different arguments.');
        if (found.outcome === 'rejected') throw fail('approval_rejected', 'This approval response failed earlier. Check pendingRequests with get_task and answer again with a new requestId if it is still pending.');
        return this.view(task);
      }
    }
    return action({requestId, hash});
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
    const matches = [...this.tasks.values()].filter(t => (!args.state || t.state===args.state) && (!directory || t.projectDirectory===directory))
      .sort(order).filter(t => !after || order(t, after) > 0);
    const page = matches.slice(0, limit), last = page[page.length-1];
    return {tasks:page.map(t=>this.summary(t)), nextCursor:matches.length>limit ? Buffer.from(last.createdAt+':'+last.taskId).toString('base64url') : null};
  }
  wait(args) {
    const task = this.get(args.taskId);
    if (args.brief !== undefined && typeof args.brief !== 'boolean') throw fail('invalid_argument', 'Invalid brief');
    const seconds = args.waitSeconds ?? 600, after = args.afterRevision;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_SECONDS) throw fail('invalid_argument', 'Invalid waitSeconds');
    if (after !== undefined && (!Number.isInteger(after) || after < 0)) throw fail('invalid_argument', 'Invalid afterRevision');
    const ready = () => settled(task) && (after === undefined || (task.revision || 0) > after);
    if (ready() || this.closed) return {...this.view(task, args.brief), timedOut:false};
    return new Promise(resolve => {
      const finish = timedOut => { clearTimeout(timer); this.waiters.delete(waiter); resolve({...this.view(task, args.brief), timedOut}); };
      const waiter = {check:()=>{ if (ready()) finish(false); }, close:()=>finish(true)};
      const timer = setTimeout(()=>finish(true), seconds*1000);
      this.waiters.add(waiter);
    });
  }
  // Wakes on the first of several tasks that needs attention, so a client running tasks in parallel waits once.
  waitAny(args) {
    if (!Array.isArray(args.taskIds) || !args.taskIds.length || args.taskIds.length > 50 || new Set(args.taskIds).size !== args.taskIds.length) throw fail('invalid_argument', 'Invalid taskIds');
    if (args.brief !== undefined && typeof args.brief !== 'boolean') throw fail('invalid_argument', 'Invalid brief');
    const seconds = args.waitSeconds ?? 600;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_WAIT_SECONDS) throw fail('invalid_argument', 'Invalid waitSeconds');
    const tasks = args.taskIds.map(id => this.get(id));
    const result = timedOut => ({settled:tasks.filter(settled).map(t=>this.view(t, args.brief)), waiting:tasks.filter(t=>!settled(t)).map(t=>t.taskId), timedOut});
    if (tasks.some(settled) || this.closed) return result(false);
    return new Promise(resolve => {
      const finish = timedOut => { clearTimeout(timer); this.waiters.delete(waiter); resolve(result(timedOut)); };
      const waiter = {check:()=>{ if (tasks.some(settled)) finish(false); }, close:()=>finish(true)};
      const timer = setTimeout(()=>finish(true), seconds*1000);
      this.waiters.add(waiter);
    });
  }
  call(name, args = {}) {
    if (this.closed) throw fail('bridge_stopped', 'MCP executor is closed.');
    if (name === 'get_task') {
      if (args.brief !== undefined && typeof args.brief !== 'boolean') throw fail('invalid_argument', 'Invalid brief');
      return this.view(this.get(args.taskId), args.brief);
    }
    if (name === 'wait_task') return this.wait(args);
    if (name === 'wait_tasks') return this.waitAny(args);
    if (name === 'list_models') return Promise.resolve(this.adapter.models?.() ?? []).then(models=>({models}));
    if (name === 'close_task') {
      const task = this.get(args.taskId);
      if (!['completed','cancelled','error'].includes(task.state) || recoveryRequired(task)) throw fail('task_active', 'Only finished tasks can have their chat closed.');
      return Promise.resolve(this.adapter.closeChat?.(task)).then(closed=>({taskId:task.taskId, state:task.state, chatClosed:!!closed}),
        error=>{ throw fail('task_active', String(error?.message || 'The task chat could not be closed.').slice(0,200)); });
    }
    if (name === 'list_tasks') return this.list(args);
    if (name === 'submit_task') return this.operation(args.requestId, name, args, op => {
      connected(this.adapter);
      string(args.description, 'description'); string(args.acceptanceCriteria, 'acceptanceCriteria', 20000);
      if (args.model !== undefined) string(args.model, 'model', 200);
      if (args.effort !== undefined) string(args.effort, 'effort', 40);
      if (this.tasks.size >= 1000) throw fail('limit', 'Task storage limit reached. Archive tasks while the bridge is stopped.');
      let projectDirectory;
      try { projectDirectory = directories.canonical(args.projectDirectory); }
      catch { throw fail('invalid_directory', 'projectDirectory must be an existing absolute directory.'); }
      const task = {taskId:randomUUID(), sessionKey:randomUUID(), state:'queued', progress:'Queued',
        projectDirectory, description:args.description,
        acceptanceCriteria:args.acceptanceCriteria, model:args.model, effort:args.effort,
        connection:this.adapter.connection(), operations:[op], createdAt:Date.now()};
      this.save(task); this.tasks.set(task.taskId, task); this.schedule(); return this.view(task);
    });
    if (!['continue_task','cancel_task'].includes(name)) throw fail('invalid_argument', 'Unknown tool');
    return this.operation(args.requestId, name, args, op => {
      const task = this.get(args.taskId);
      if (task.operations.length >= 1000) throw fail('limit', 'Task operation limit reached.');
      if (name === 'continue_task') {
        if (args.approval) {
          const pending = this.adapter.pending(task).find(p=>String(p.id)===String(args.approval.id));
          if (!pending || task.state !== 'waiting_approval') throw fail('approval_not_pending', 'Approval request is no longer pending.');
          // Durable intent first: a lost reply must never replay an approval.
          op.outcome='pending'; task.operations.push(op); this.save(task);
          return Promise.resolve(this.adapter.answer(task, args.approval)).then(()=>{
            op.outcome='applied'; task.state='running'; task.progress='Approval response sent'; this.save(task); return this.view(task);
          }, error=>{
            op.outcome='rejected'; this.save(task);
            throw fail('approval_rejected', 'Approval response was rejected: ' + String(error?.message || 'unknown reason').slice(0,200));
          });
        }
        string(args.clarification, 'clarification');
        connected(this.adapter, task);
        if(active.has(task.state)) {
          task.continuations ||= [];
          if(task.continuations.length>=20)throw fail('limit', 'Too many queued continuations.');
          task.continuations.push(args.clarification);
        } else {task.nextInput=args.clarification; task.state='queued'; task.error=null; task.cancelRequested=false;}
        task.progress='Continuation queued';
      } else {
        // Record no-op cancellations too, so a replayed request can never cancel a later turn.
        if (!active.has(task.state) && !task.recoveryRequired) { task.operations.push(op); this.save(task); return this.view(task); }
        task.cancelRequested=true;
        task.continuations=[];
        if (task.state === 'queued' && !task.recoveryRequired) {
          task.state='cancelled'; task.progress='Cancelled before execution';
          this.release(task);
        } else { task.state='running';task.progress='Cancellation requested'; }
      }
      task.operations.push(op); this.save(task);
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
        if (['running','waiting_approval'].includes(task.state) && !this.starting.has(task.taskId)) {
          let status;
          try { status = await this.adapter.status(task); }
          catch { if (this.closed) return; task.state='error';task.recoveryRequired=true;task.needsReconcile=true;task.error='Chat status unavailable. Restore the connection and explicitly continue after inspecting the chat.';this.save(task);continue; }
          if (this.closed) return;
          this.update(task, ()=>{
            task.pendingIds=this.adapter.pending(task).map(r=>String(r.id));
            if (status.chatId) task.chatId=status.chatId;
            if (status.done) {
              task.state=status.cancelled?'cancelled':status.failed?'error':'completed';
              task.progress='Turn finished'; task.report=status.report; task.recoveryRequired=false;
              if(task.state==='completed' && task.continuations?.length){task.nextInput=task.continuations.shift();task.state='queued';task.progress='Continuation queued';}
              else this.release(task);
            } else { task.state=status.pending?'waiting_approval':'running'; task.progress=status.progress || task.progress; }
          });
        }
      }
      // Up to maxParallel turns run at once; directory leases keep one turn per project/worktree.
      // Queued tasks whose recovered turn is known to be live are counted up front, so the limit holds before they are reached.
      const counted = new Set([...this.tasks.values()].filter(t=>t.state==='queued' && t.liveRecovery).map(t=>t.taskId));
      let capacity = this.limit() - [...this.tasks.values()].filter(t=>['running','waiting_approval'].includes(t.state)).length - counted.size;
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
      }
    } finally {
      this.executing=false;
      // Only blocked queued tasks remain: retry once a second instead of re-probing every 50 ms.
      const tasks=[...this.tasks.values()];
      if (tasks.some(t=>['running','waiting_approval'].includes(t.state))) this.schedule();
      else if (tasks.some(t=>t.state==='queued')) this.schedule(1000);
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
    task.state='running'; task.progress='Starting existing Codex executor'; task.recoveryRequired=true; task.awaitingPreparation=false; this.save(task);
    try {
      await this.adapter.start(task, task.nextInput || task.description + '\n\nAcceptance criteria:\n' + task.acceptanceCriteria +
        '\n\nFinish with a report containing result, changed files, checks performed and remaining issues.',()=>this.save(task));
      delete task.nextInput;
      task.chatId=this.adapter.chatId(task); this.save(task);
    } catch (error) {
      if(task.cancelRequested && (task.awaitingPreparation || error?.retryable)){
        task.state='cancelled';task.recoveryRequired=false;task.progress='Cancelled before model execution';
        this.release(task);this.save(task);return;
      }
      // Nothing was sent (another turn holds the connection or credentials): wait and start again.
      if(error?.retryable && !task.cancelRequested){
        task.state='queued';task.recoveryRequired=false;task.progress='Waiting to start: the connection is busy with another turn';
        task.blockedUntil=Date.now()+5000;directories.release(this.directoryStore,task.projectDirectory,task.taskId);this.save(task);return;
      }
      task.state='error'; task.progress='Execution stopped'; task.error='Execution could not be confirmed. Inspect the chat before continuing; input was not retried.';
      task.needsReconcile=true;
      this.save(task);
    }
  }
  dispose() { this.closed=true; clearTimeout(this.scheduled); for (const waiter of [...this.waiters]) waiter.close(); }
}
module.exports={McpTasks, recoveryRequired, MAX_WAIT_SECONDS};
