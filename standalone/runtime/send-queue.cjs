// Host state is supplied explicitly; mutable values are read through deps.
async function send(deps, s, text, attached=s.attachments, options={}) {
  const composerDraft=require('./composer-draft.cjs'),draft=composerDraft.snapshot(s);
  // retryable marks failures that happen before anything is sent and clear up by themselves; MCP tasks wait and retry.
  if (deps.authBusy) throw Object.assign(Error(deps.pendingLogin.current ? deps.browserSignInMessage() : deps.locale.t('Дождитесь переключения аккаунта.')),{notSent:true,retryable:true});
  if(s.sendingTask)throw Object.assign(Error(deps.locale.t('Дождитесь обработки уточнений перед согласованием.')),{notSent:true,retryable:true});
  let accountLease;
  // Only a held lease is 'busy in another window'; file-system failures keep their own message and are not retried.
  try{accountLease = deps.store.acquire('account-credentials');}catch(error){if(error?.syscall)throw Object.assign(error,{notSent:true});throw Object.assign(Error(deps.browserSignInMessage(true)),{notSent:true,retryable:true});}
  let directoryLease=null, leasedDirectory=null;
  const ensureDirectory=()=>{
    const actual=deps.taskDirectory.canonical(s.cwd || deps.cwd());
    if(options.projectDirectory && actual!==options.projectDirectory)throw Error('MCP chat project directory changed.');
    if(actual!==leasedDirectory){const next=deps.taskDirectory.acquire(deps.store,actual,options.taskId);directoryLease?.();directoryLease=next;leasedDirectory=actual;}
  };
  s.sendingTask=true;
  // Everything thrown before turn/start is requested provably sent nothing; callers may retry or re-answer.
  let turnRequested=false;
  try {
  if (s.busy)
    throw Error(deps.locale.t("Дождитесь ответа или остановите текущую задачу."));
  if (typeof text !== "string" || (!text.trim() && !attached.some(file=>file.kind==='image')) || text.length > 200000)
    throw Error(deps.locale.t("Введите сообщение длиной до 200 000 символов."));
  if (!deps.trusted())
    throw Error(
      deps.locale.t("Сначала разрешите доверие рабочему пространству VS Code."),
    );
  await deps.syncExternal(s);
  ensureDirectory();
  await deps.applyPendingMode(s);
  const accountRevisionBeforeConnect=deps.accountReadRevision;
  await deps.connect();
  if(options.requiredConnection && (deps.activeConnection?.id!==options.requiredConnection.id || deps.activeConnection?.revision!==options.requiredConnection.revision || !deps.activeConnection?.provider))throw Error('MCP task connection changed.');
  deps.connections.assertCurrent(deps.activeConnection);
  if (deps.activeConnection.provider) await deps.activeConnection.provider.authenticate(deps.providerClient(deps.server, deps.activeConnection));
  // A cold connection already read the account and loaded its model catalog.
  const initializedHere=deps.accountReadRevision!==accountRevisionBeforeConnect;
  const accountChanged=initializedHere ? false : await deps.refreshAccount();
  if (!deps.account) throw Error(deps.locale.t("Войдите в Codex через /account."));
  await Promise.all([
    initializedHere && deps.limits.updatedAt && !deps.limits.error ? (deps.limitsRequest || Promise.resolve()) : deps.refreshLimits(),
    accountChanged || (deps.Date || Date).now()-deps.catalogUpdatedAt>60000 ? deps.refreshCatalog() : Promise.resolve(),
  ]);
  if (deps.activeConnection.provider?.prepareTurn) {
    const connection = deps.activeConnection;
    const assertCanChange = () => {
      deps.connections.assertCurrent(connection);
      if ([...deps.sessions.values()].some(session => session.busy || session.compacting)) throw Object.assign(Error('Finish active tasks before changing the connection.'),{retryable:true});
      try{deps.store.assertNoActiveTurns();}catch(error){throw Object.assign(error,{retryable:true});}
    };
    const decision = await connection.provider.prepareTurn({
      limits: {...deps.limits},
      assertCanChange,
      reconnect: async () => {
        assertCanChange();
        await deps.resetConnection();
      },
      readLimits: async () => { await deps.refreshLimits(); return {...deps.limits}; },
    });
    deps.connections.assertCurrent(connection);
    if (decision?.waitUntil) return {waitUntil:decision.waitUntil,connection};
  }
  const exhausted = require('../ui/limits.js').exhaustion(deps.limits);
  if(options.requiredConnection && (deps.activeConnection?.id!==options.requiredConnection.id || deps.activeConnection?.revision!==options.requiredConnection.revision || !deps.activeConnection?.provider))throw Error('MCP task connection changed.');
  if(exhausted && !deps.server.handlesTurnAdmission){
    const date=exhausted.resetAt?new Intl.DateTimeFormat(undefined,{dateStyle:'short',timeStyle:'short'}).format(exhausted.resetAt):null;
    throw Error(date?deps.locale.t('Лимиты аккаунта закончились. Дождитесь сброса: {0}. Запрос сохранён.',date):deps.locale.t('Лимиты аккаунта закончились. Дождитесь сброса лимитов. Запрос сохранён.'));
  }
  deps.updateDraftModel(s);
  const selection={model:s.model,effort:s.effort,fast:s.prefs.fast,...options.modelSelection};
  if (s.id && !s.loaded) await deps.resume(s, s.id);
  ensureDirectory();
  const selectedModel=deps.catalog.find(model=>model.model===selection.model);
  if (!selectedModel)
    throw Error(
      deps.locale.t(
        "Выберите модель, доступную текущему аккаунту. Контекст сессии сохранён.",
      ),
    );
  if(selection.effort && !selectedModel.supportedReasoningEfforts.some(option=>option.reasoningEffort===selection.effort))
    throw Error(deps.locale.t("Эта модель не поддерживает выбранную глубину."));
  if(options.approvedTask && (!s.preflight?.enabled || deps.hasPendingQuestions(s)))
    throw Error(deps.locale.t('План изменился или ещё не готов к согласованию.'));
  if(s.preflight?.enabled){
    if(options.approvedTask){
      deps.preflight.approve(s.preflight,options.approvedTask.id,options.approvedTask.revision);
    }else deps.preflight.revise(s.preflight);
    await deps.save(s);
  }
  const preparing=deps.preflight.preparing(s.preflight);
  const mode = deps.modes.current(s.prefs),
    policy = preparing?deps.preflight.policy():deps.modes.policy(mode.id, s.cwd || deps.cwd()),
    { approvalPolicy, approvalsReviewer, sandboxPolicy } = policy;
  const serviceTier=deps.speed.effectiveTier(selectedModel,selection.fast===true);
  if (!s.id) {
    const result = await deps.server.request("thread/start", {
      cwd: s.cwd || deps.cwd(),
      model: selection.model,
      approvalPolicy,
      approvalsReviewer,
      sandbox: policy.sandbox,
      serviceTier:serviceTier==='default'?null:serviceTier,
      ...(s.preflight?.enabled?{config:await deps.preparationConfig(s)}:deps.mcpThreadConfig(s)?{config:deps.mcpThreadConfig(s)}:{}),
    });
    s.id = result.thread.id;
    s.cwd = result.thread.cwd || s.cwd;
    await deps.library.migrate(s.key, s.id);
    s.loaded = true;
    s.model = result.model;
    s.effort = s.effort || result.reasoningEffort;
    if (!s.customName) s.name = text.trim().replace(/\s+/g, " ").slice(0, 64) || deps.locale.t('Изображение');
    await deps.server.request("thread/name/set", { threadId: s.id, name: s.name });
    await deps.save(s);
  }
  ensureDirectory();
  const input = deps.buildInput(text, attached, options.includeIde!==false && s.prefs.ide ? deps.editorSelection() : null);
  const sessionRelease = deps.store.acquire(s.id), releaseDirectory=directoryLease;
  const client=deps.server, connection=deps.activeConnection, threadId=s.id,
    previousTurnId=s.turnId || s.lastStartedTurnId || [...s.items].reverse().find(item=>item.turnId)?.turnId;
  let unresolved=true, startPending=true, startUncertain=false, released=false, observed=null;
  let reconciliationTimer, reconciliationDeadline;
  const stopReconciliation=()=>{
    if(reconciliationTimer!==undefined)(deps.clearTimeout || clearTimeout)(reconciliationTimer);
    if(reconciliationDeadline!==undefined)(deps.clearTimeout || clearTimeout)(reconciliationDeadline);
  };
  const current=()=>deps.server===client && deps.activeConnection===connection && s.id===threadId;
  const release = () => {
    // Disconnect cleanup cannot turn an unanswered mutation into a clean failure.
    if(unresolved || (startPending || startUncertain) && observed?.status==='inProgress' || released)return;
    released=true;stopReconciliation();sessionRelease();releaseDirectory?.();
    client.removeListener?.('notification',observeTurn);
    client.removeListener?.('disconnected',observeDisconnect);
    if(deps.turnLeases.get(threadId)===release)deps.turnLeases.delete(threadId);
  };
  const observeTurn=message=>{
    const p=message.params;
    // The listener belongs to this client, so its own turn always settles the leases,
    // even after the chat or connection moved on; only the chat state needs current().
    if(p?.threadId!==threadId || !p.turn?.id || p.turn.id===previousTurnId ||
      !['turn/started','turn/completed'].includes(message.method))return;
    if(observed && observed.id!==p.turn.id)return;
    observed={id:p.turn.id,status:message.method==='turn/started'?'inProgress':p.turn.status};
    stopReconciliation();
    unresolved=false;
    if(current()){
      s.lastStartedTurnId=p.turn.id;
      s.busy=message.method==='turn/started';s.turnId=s.busy?p.turn.id:null;
      if(!s.busy)s.lastTurnStatus=p.turn.status;
    }
    if(message.method==='turn/completed')release();
  };
  // The Codex process is gone, so no turn of this request can still run: free the chat.
  // The pending request still rejects as deliveryUncertain, so queued input is never replayed.
  const observeDisconnect=()=>{unresolved=false;startPending=false;startUncertain=false;observed=null;release();};
  client.on?.('notification',observeTurn);
  client.on?.('disconnected',observeDisconnect);
  directoryLease=null;
  deps.turnLeases.set(s.id, release);
  s.error = null;
  s.stopRequested=false;
  s.busy = true;
  s.turnId = null;
  s.turnModel = selection.model;
  s.turnStartedAt=(deps.Date || Date).now();
  deps.publish(s);
  try {
    turnRequested=true;
    const result = await client.request("turn/start", {
      threadId: s.id,
      serviceTierForTurn:serviceTier,
      input,
      cwd: s.cwd,
      model: selection.model,
      effort: selection.effort,
      approvalPolicy,
      approvalsReviewer,
      sandboxPolicy,
      ...(preparing?{outputSchema:deps.preflight.schema}:options.outputSchema?{outputSchema:options.outputSchema}:{}),
      collaborationMode: {
        // Our JSON proposal has its own workflow; native Plan uses a different final format.
        mode: s.preflight?.enabled ? 'default' : s.prefs.plan ? 'plan' : 'default',
        settings: {
          model: selection.model,
          reasoning_effort: selection.effort,
          developer_instructions: (options.taskId || options.projectDirectory
            ? 'The requester is an automated agent client; no human watches this task chat. Decide routine implementation details yourself. When a decision really requires the client, use the blocking request_user_input tool with concise options. Put the recommended option first and mark its label (Recommended). Never use request_user_input_async and never wait for a human in the chat. A skipped question or empty answers are not consent or a selection; continue with reasonable assumptions where possible.'
            : s.preflight?.enabled?deps.preflight.instructions(s.preflight):'When a clarification would materially improve the task, ask a concise structured quiz using request_user_input or request_user_input_async when available. Put the recommended option first and mark its label (Recommended). Ask when the user requests a quiz. Do not ask about routine implementation details. A skipped quiz or empty answers are not consent or a selection; continue with reasonable assumptions where possible.') +
            (s.prefs.focus?' Before using tools for a task, send a brief user-facing commentary explaining your next action. During longer work, send concise commentary at meaningful progress boundaries before the related tool steps. Use commentary messages for these updates, not tool output or private reasoning. Do not invent progress or delay direct answers that require no tools.':''),
        },
      },
    });
    startPending=false;unresolved=false;
    // Consume recoverable input at confirmed delivery, including a retry after
    // companion preparation failed. Later bookkeeping must not leave it unsent.
    const draftConsumed=!!(current() && options.consumeDraft!==false && draft.text===text && composerDraft.consume(s,draft));
    if(current())s.lastStartedTurnId=result.turn.id;
    observed ||= {id:result.turn.id,status:s.busy?'inProgress':'completed'};
    if(!s.busy)release();
    if (current() && s.busy) s.turnId = result.turn.id;
    if(current() && s.busy && s.stopRequested)await client.request('turn/interrupt',{threadId,turnId:result.turn.id});
    const consumed=new Set(attached.map(file=>file.id));s.attachments=s.attachments.filter(file=>!consumed.has(file.id));
    return {turnId:result.turn.id,draftConsumed};
  } catch (error) {
    startPending=false;
    if(!observed && error.deliveryUncertain===false){
      unresolved=false;release();
      if(current())s.busy=false;
    }else{
      // Unknown errors are conservative too: never automatically resend input.
      startUncertain=true;
      error.deliveryUncertain=true;
      if(!observed && current()){
        const owns=()=>!observed && !released && current() && deps.turnLeases.get(threadId)===release;
        const reconciliationStarted=(deps.Date || Date).now();
        // Bound even repeated RPC failures; expiry never makes input safe to replay.
        const expire=()=>{
          if(!owns())return;
          unresolved=false;s.busy=false;s.turnId=null;
          s.error=deps.locale.language==='en'
            ? 'Message delivery could not be confirmed. Check the chat before resending.'
            : 'Не удалось подтвердить доставку сообщения. Проверьте чат перед повторной отправкой.';
          release();deps.publish(s);
        };
        const reconcile=async()=>{
          if(!owns())return;
          try{
          const turns=await client.request('thread/turns/list',{
            threadId,limit:1,sortDirection:'desc',itemsView:'summary',
          },5000);
          // A notification wins over a stale list response, as does a new owner.
          if(owns() && Array.isArray(turns.data)){
            const turn=turns.data[0];
            if(turn?.id && turn.id!==previousTurnId && ['inProgress','completed','interrupted','failed'].includes(turn.status)){
              observed={id:turn.id,status:turn.status};unresolved=false;stopReconciliation();
              s.lastStartedTurnId=turn.id;
              s.busy=turn.status==='inProgress';s.turnId=s.busy?turn.id:null;
              if(!s.busy){s.lastTurnStatus=turn.status;release();}
              deps.publish(s);
            }
          }
          }catch{ /* An unavailable list is unresolved, just like an empty or previous turn. */ }
          if(owns()){
            reconciliationTimer=(deps.setTimeout || setTimeout)(()=>{void reconcile();},5000);
            reconciliationTimer.unref?.();
          }
        };
        await reconcile();
        if(owns()){
          reconciliationDeadline=(deps.setTimeout || setTimeout)(expire,Math.max(0,30000-((deps.Date || Date).now()-reconciliationStarted)));
          reconciliationDeadline.unref?.();
        }
      }else if(!observed){
        // The chat moved on: only this request's leases remain; a late turn event
        // still settles them, otherwise they expire instead of blocking the project.
        reconciliationDeadline=(deps.setTimeout || setTimeout)(()=>{if(!observed && !released){unresolved=false;release();}},30000);
        reconciliationDeadline.unref?.();
      }
    }
    throw error;
  } finally {
    deps.publish(s);
  }
  } catch (error) {
    if (!turnRequested && error && typeof error === 'object') error.notSent = true;
    throw error;
  } finally { s.sendingTask=false;directoryLease?.();accountLease(); }
}

async function queueFollowUp(deps, s,text,attachments){
  if(s.queueMutation)throw Error(deps.locale.t('Дождитесь сохранения очереди.'));
  const releaseQueue=deps.acquireQueuedSession(s,key=>deps.store.acquire(key));
  let finishEnqueue;
  s.queueEnqueue=new Promise(resolve=>{finishEnqueue=resolve;});
  s.queueMutation=true;s.queueDrainDeferred=false;
  try {
    deps.assertQueueCurrent(s,deps.store.session(s.key));
    const queue=s.followUps || [];
    if(queue.length>=20)throw Error(deps.locale.t('В очереди уже 20 сообщений.'));
    const item={id:deps.randomUUID(),text,attachments:[...attachments],
      modelSelection:typeof s.model==='string'?{model:s.model,effort:s.effort,fast:s.prefs.fast===true}:undefined};
    const consumed=new Set(attachments.map(file=>file.id)), draft=s.draft, previousRecord=s.persistedRecord;
    const snapshot={...s,followUps:[...queue,item],attachments:s.attachments.filter(file=>!consumed.has(file.id)),
      draft:draft===text?'':draft};
    try{await deps.save(snapshot);}catch(error){
      if(snapshot.persistedRecord===previousRecord)throw error;
      // The local atomic record is authoritative even if the VS Code cache failed.
      deps.output.appendLine('[queue] workspace-state-update-failed');
    }
    s.followUps=snapshot.followUps;s.persistedRecord=snapshot.persistedRecord;
    s.attachments=s.attachments.filter(file=>!consumed.has(file.id));
    if(s.draft===draft)s.draft=snapshot.draft;
    deps.publish(s);return item;
  } finally {
    const deferred=s.queueDrainDeferred;
    s.queueMutation=false;s.queueDrainDeferred=false;s.queueEnqueue=null;finishEnqueue();releaseQueue();
    if(deferred && !s.busy && !s.queuePaused && !s.error)
      void deps.drainFollowUps(s).catch(error=>{s.error=error.message;deps.publish(s);});
  }
}

async function steer(deps, s,text,attachments){
  if(!s.id || !s.turnId || s.compacting)return false;
  const expectedTurnId=s.turnId;
  try{
    await deps.server.request('turn/steer',{threadId:s.id,expectedTurnId,input:deps.buildInput(text,attachments)});
    const consumed=new Set(attachments.map(file=>file.id));s.attachments=s.attachments.filter(file=>!consumed.has(file.id));
    await deps.save(s);deps.publish(s);return true;
  }catch(error){
    // Only a definite refusal can be queued; a timeout might already have been accepted.
    if(/no active turn|not active|expected.*turn.*(?:match|different)|turn.*mismatch/i.test(error.message))return false;
    throw error;
  }
}

async function drainFollowUps(deps, s,{manual=false}={}){
  if(s.busy || s.followUpSending || s.queuePaused && !manual || !s.followUps?.length)return;
  if(s.queueMutation){if(!manual)s.queueDrainDeferred=true;return;}
  const releaseQueue=deps.acquireQueuedSession(s,key=>deps.store.acquire(key));
  try {
    deps.assertQueueCurrent(s,deps.store.session(s.key));
    const item=s.followUps[0];s.followUpSending=true;deps.publish(s);
    try{
      if(item.deliveryUncertain)throw Error(deps.locale.t('Доставка сообщения не подтверждена. Проверьте чат перед повторной отправкой.'));
      await deps.applyPendingMode(s);
      const result=await deps.send(s,item.text,item.attachments,{modelSelection:item.modelSelection});
      if(result?.waitUntil)throw Error(deps.locale.t('Очередь ожидает сброса лимитов. Повторите отправку позже.'));
      // Enqueue may be persisting a snapshot containing this in-flight item.
      await s.queueEnqueue;
      s.followUps=s.followUps.filter(row=>row.id!==item.id);await deps.save(s);deps.publish(s);
    }catch(error){
      if(error.deliveryUncertain){
        await s.queueEnqueue;
        const queued=s.followUps.find(row=>row.id===item.id);
        if(queued){queued.deliveryUncertain=true;await deps.save(s);}
      }
      s.error=error.message;throw error;
    }finally{
      s.followUpSending=false;deps.publish(s);
      if(!s.busy && s.lastTurnStatus==='completed' && !s.stopRequested && s.followUps?.length && !s.error)
        (deps.setTimeout || setTimeout)(()=>void deps.drainFollowUps(s).catch(error=>{s.error=error.message;deps.publish(s);}),0);
    }
  } finally {releaseQueue();}
}
module.exports = { send, queueFollowUp, steer, drainFollowUps };
