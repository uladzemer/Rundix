// Durable task orchestration. The adapter is the existing extension executor.
const fs = require('node:fs');
const {randomUUID, createHash} = require('node:crypto');
const directories = require('./task-directory.cjs');
const active = new Set(['queued', 'running', 'waiting_approval']);
function string(value, name, limit = 100000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw Error('Invalid ' + name);
  return value;
}
function stable(value) { return value && typeof value==='object' ? Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])) : value; }
function fingerprint(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
// The stored flag also marks an in-flight turn for restart reconciliation; clients only see it once execution stopped.
function recoveryRequired(task) { return !!task.recoveryRequired && !['running','waiting_approval'].includes(task.state); }
class McpTasks {
  constructor({store, adapter, directoryStore = store}) {
    this.store = store; this.directoryStore=directoryStore; this.adapter = adapter; this.tasks = new Map(); this.executing = false; this.closed = false;
    for (const name of fs.readdirSync(store.directory).filter(n => /^mcp-task-[\w-]+\.json$/.test(n))) {
      const task = store.read('mcp-task', name.slice(9, -5));
      if (!task?.taskId || task.taskId!==name.slice(9,-5) || !Array.isArray(task.operations) || typeof task.projectDirectory!=='string' || !['queued','running','waiting_approval','completed','error','cancelled'].includes(task.state)) throw Error('MCP task storage is unreadable.');
      if(['running','waiting_approval'].includes(task.state) || task.recoveryRequired)task.needsReconcile=true;
      this.tasks.set(task.taskId, task);
    }
  }
  save(task) { task.updatedAt = Date.now(); this.store.write('mcp-task', task.taskId, task); }
  get(id) { const task = this.tasks.get(id); if (!task) throw Error('Unknown taskId'); return task; }
  view(task) {
    return JSON.parse(JSON.stringify({taskId:task.taskId, state:task.state, progress:task.progress,
      chatId:task.chatId || null, projectDirectory:task.projectDirectory, createdAt:task.createdAt,
      updatedAt:task.updatedAt, report:task.report || null, error:task.error || null,
      queuedContinuations:task.continuations?.length || 0,
      recoveryRequired:recoveryRequired(task), pendingRequests:this.adapter.pending(task)}));
  }
  operation(requestId, method, args, action) {
    string(requestId, 'requestId', 128);
    const hash = fingerprint([method, args]);
    for (const task of this.tasks.values()) {
      const found = task.operations.find(op => op.requestId === requestId);
      if (found) {
        if (found.hash !== hash) throw Error('requestId was already used for different arguments.');
        return this.view(task);
      }
    }
    return action({requestId, hash});
  }
  call(name, args = {}) {
    if (this.closed) throw Error('MCP executor is closed.');
    if (name === 'get_task') return this.view(this.get(args.taskId));
    if (name === 'list_tasks') {
      const limit = args.limit ?? 25;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid limit');
      return [...this.tasks.values()].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,limit).map(t=>this.view(t));
    }
    if (name === 'submit_task') return this.operation(args.requestId, name, args, op => {
      this.adapter.assertConnection();
      string(args.description, 'description'); string(args.acceptanceCriteria, 'acceptanceCriteria', 20000);
      if (args.model !== undefined) string(args.model, 'model', 200);
      if (args.effort !== undefined) string(args.effort, 'effort', 40);
      if (this.tasks.size >= 1000) throw Error('Task storage limit reached. Archive tasks while the bridge is stopped.');
      const task = {taskId:randomUUID(), sessionKey:randomUUID(), state:'queued', progress:'Queued',
        projectDirectory:directories.canonical(args.projectDirectory), description:args.description,
        acceptanceCriteria:args.acceptanceCriteria, model:args.model, effort:args.effort,
        connection:this.adapter.connection(), operations:[op], createdAt:Date.now()};
      this.save(task); this.tasks.set(task.taskId, task); this.schedule(); return this.view(task);
    });
    if (!['continue_task','cancel_task'].includes(name)) throw Error('Unknown tool');
    return this.operation(args.requestId, name, args, op => {
      const task = this.get(args.taskId);
      if (task.operations.length >= 1000) throw Error('Task operation limit reached.');
      if (name === 'continue_task') {
        if (args.approval) {
          const pending = this.adapter.pending(task).find(p=>String(p.id)===String(args.approval.id));
          if (!pending || task.state !== 'waiting_approval') throw Error('Approval request is no longer pending.');
          // Durable intent first: a lost reply must never replay an approval.
          task.operations.push(op); this.save(task);
          return Promise.resolve(this.adapter.answer(task, args.approval)).then(()=>{
            task.state='running'; task.progress='Approval response sent'; this.save(task); return this.view(task);
          });
        }
        string(args.clarification, 'clarification');
        this.adapter.assertConnection(task);
        if(active.has(task.state)) {
          task.continuations ||= [];
          if(task.continuations.length>=20)throw Error('Too many queued continuations.');
          task.continuations.push(args.clarification);
        } else {task.nextInput=args.clarification; task.state='queued'; task.error=null; task.cancelRequested=false;}
        task.progress='Continuation queued';
      } else {
        if (!active.has(task.state) && !task.recoveryRequired) return this.view(task);
        task.cancelRequested=true;
        task.continuations=[];
        if (task.state === 'queued' && !task.recoveryRequired) {
          task.state='cancelled'; task.progress='Cancelled before execution';
          directories.release(this.directoryStore,task.projectDirectory,task.taskId);
        } else { task.state='running';task.progress='Cancellation requested'; }
      }
      task.operations.push(op); this.save(task);
      if (name === 'cancel_task' && task.state !== 'cancelled') {
        void Promise.resolve(this.adapter.cancel(task)).catch(()=>{task.error='Cancellation could not be confirmed; query task again.';this.save(task);});
      }
      this.schedule(); return this.view(task);
    });
  }
  schedule() {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(()=>{ this.scheduled=null; void this.tick().catch(()=>{}); }, 50);
    this.scheduled.unref?.();
  }
  async tick() {
    if (this.closed || this.executing) return;
    this.executing=true;
    try {
      for (const task of this.tasks.values()) {
        if (['running','waiting_approval'].includes(task.state)) {
          let status;
          try { status = await this.adapter.status(task); }
          catch { task.state='error';task.recoveryRequired=true;task.needsReconcile=true;task.error='Chat status unavailable. Restore the connection and explicitly continue after inspecting the chat.';this.save(task);continue; }
          if (status.chatId) task.chatId=status.chatId;
          if (status.done) {
            task.state=status.cancelled?'cancelled':status.failed?'error':'completed';
            task.progress='Turn finished'; task.report=status.report; task.recoveryRequired=false;
            if(task.state==='completed' && task.continuations?.length){task.nextInput=task.continuations.shift();task.state='queued';task.progress='Continuation queued';}
            else directories.release(this.directoryStore,task.projectDirectory,task.taskId);
          } else { task.state=status.pending?'waiting_approval':'running'; task.progress=status.progress || task.progress; }
          this.save(task);
        }
      }
      if ([...this.tasks.values()].some(t=>['running','waiting_approval'].includes(t.state))) return;
      const task=[...this.tasks.values()].find(t=>t.state==='queued');
      if (!task) return;
      try {
        this.adapter.assertConnection(task);
        // Recovery only observes the old chat; it never resubmits its old input.
        if (task.recoveryRequired) {
          const status=await this.adapter.status(task);
          if (!status.done) {
            if(task.cancelRequested){task.state='running';this.save(task);}
            throw Error('The previous turn is still active.');
          }
          task.recoveryRequired=false;
        }
        if(task.cancelRequested){
          task.state='cancelled';task.progress='Cancellation confirmed';
          directories.release(this.directoryStore,task.projectDirectory,task.taskId);this.save(task);return;
        }
        directories.reserve(this.directoryStore,task.projectDirectory,task.taskId);
      } catch { task.progress='Waiting for connection or project directory; inspect selected companion and prior task'; this.save(task); return; }
      task.state='running'; task.progress='Starting existing Codex executor'; task.recoveryRequired=true; task.awaitingPreparation=false; this.save(task);
      try {
        await this.adapter.start(task, task.nextInput || task.description + '\n\nAcceptance criteria:\n' + task.acceptanceCriteria +
          '\n\nFinish with a report containing result, changed files, checks performed and remaining issues.',()=>this.save(task));
        delete task.nextInput;
        task.chatId=this.adapter.chatId(task); this.save(task);
      } catch {
        if(task.cancelRequested && task.awaitingPreparation){
          task.state='cancelled';task.recoveryRequired=false;task.progress='Cancelled before model execution';
          directories.release(this.directoryStore,task.projectDirectory,task.taskId);this.save(task);return;
        }
        task.state='error'; task.progress='Execution stopped'; task.error='Execution could not be confirmed. Inspect the chat before continuing; input was not retried.';
        task.needsReconcile=true;
        this.save(task);
      }
    } finally { this.executing=false; if ([...this.tasks.values()].some(t=>active.has(t.state))) this.schedule(); }
  }
  dispose() { this.closed=true; clearTimeout(this.scheduled); }
}
module.exports={McpTasks, recoveryRequired};
