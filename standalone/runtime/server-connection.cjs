// Host state is supplied explicitly; mutable values are read through deps.
async function connect(deps) {
  if (deps.connecting) {
    if (deps.activeConnection) deps.connections.assertCurrent(deps.activeConnection);
    return deps.connecting;
  }
  deps.connectionStarting = true;
  deps.connecting = (async () => {
    deps.activeConnection = await deps.connections.resolve();
    if (deps.cwd()) deps.fs.mkdirSync(deps.storagePath, { recursive: true });
    deps.server = new deps.AppServer({
      executable: deps.path.resolve(await deps.resolveCli()),
      // The shared server outlives turns. Its Windows cwd must not pin a worktree.
      // Chat/project directories are supplied by thread/start and turn/start.
      cwd: deps.cwd() ? deps.storagePath : undefined,
      configArgs:['-c','features.default_mode_request_user_input=true'],
    });
    const notificationServer=deps.server;
    deps.server.on("notification", (message) => {
      if(deps.server!==notificationServer)return;
      if (message.method === "account/rateLimits/updated") {
        const update = require("../ui/limits.js").normalize(message.params);
        if (update.length) {
          const merged = new Map(deps.limits.buckets.map((b) => [b.id, b]));
          for (const bucket of update) merged.set(bucket.id, bucket);
          deps.limits = {
            buckets: [...merged.values()],
            loading: false,
            updatedAt: (deps.Date || Date).now(),
            error: false,
          };
          deps.broadcast();
        }
        return;
      }
      if (message.method === "serverRequest/resolved") {
        deps.pendingRequests.delete(String(message.params.requestId));
        deps.broadcast();
        return;
      }
      if (message.method === "account/login/completed") {
        const pending = deps.pendingLogin.current;
        if (pending?.client === notificationServer && !pending.id) {
          // A response and its notification may share a transport chunk;
          // login/start's await continuation has not assigned the ID yet.
          (pending.completions ||= []).push(message);
          return;
        }
        if (!deps.pendingLogin.complete(notificationServer, message.params.loginId)) return;
        if (!message.params.success) {
          const active = deps.target();
          if (active)
            active.error = message.params.error || "Login cancelled";
          deps.broadcast();
        }
      }
      if (
        message.method === "account/updated" ||
        message.method === "account/login/completed"
      ) {
        // Provider login may notify before its account revision/lease is stable.
        // Bootstrap already awaits authentication and then reads account/catalog;
        // don't let an earlier background read poison that shared catalog promise.
        if (deps.deferProviderNotifications && deps.connectionStarting && deps.activeConnection?.provider) {
          deps.onDeferredProviderRefresh?.();
          return;
        }
        deps.limitsEpoch++;
        deps.limitsRequest = null;
        deps.limits = {
          buckets: [],
          loading: false,
          updatedAt: null,
          error: false,
        };
        deps.broadcast();
        void deps.refreshAccount()
          .then(() => deps.refreshLimits())
          .then(() => deps.refreshCatalog())
          .then(async () => {
            if (
              message.method === "account/login/completed" &&
              message.params.success
            ) {
              const active = deps.target();
              if (active && deps.hasChat(active)) void deps.loadSelected(active);
            }
          })
          .catch((error) => {
            const active = deps.target();
            if (active) {
              active.error = error.message;
              deps.publish(active);
            }
          });
      }
      if (
        message.method === "item/completed" &&
        message.params?.item?.type === "fileChange"
      )
        deps.projectFiles.clear();
      notifySessions(deps, message);
      deps.treeEvents.fire();
    });
    deps.server.on("request", (request) => {
      const provider = deps.activeConnection?.provider;
      if (provider?.requestMethods?.includes(request.method)) {
        const owner = deps.activeConnection, client = deps.server;
        void Promise.resolve().then(() => {
          deps.connections.assertCurrent(owner);
          return provider.handleRequest(deps.providerClient(client, owner), request);
        }).catch(() => {
          if (deps.server === client) client.respond(request.id, null, {code:-32000,message:'Connection authorization is unavailable. Retry after reconnecting.'});
        });
        return;
      }
      const owner=[...deps.sessions.values()].find(s=>s.id===request.params?.threadId);
      if(deps.preflight.preparing(owner?.preflight) && request.method!=='item/tool/requestUserInput'){
        deps.server.respond(request.id,null,{code:-32600,message:'Task preparation does not grant tool approvals.'});
        return;
      }
      const known = [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
        "item/permissions/requestApproval",
        "mcpServer/elicitation/request",
      ];
      if (!known.includes(request.method)) {
        deps.server.respond(request.id, null, {
          code: -32601,
          message: "This local client does not implement " + request.method,
        });
        return;
      }
      deps.pendingRequests.set(String(request.id), request);
      deps.broadcast();
      if (
        ![...deps.sessions.values()].some(
          (s) => s.id === request.params?.threadId && deps.hasChat(s),
        )
      )
        void deps.notify(
          deps.locale.t(
            "Codex ожидает ответа в другой сессии. Откройте её в Rundix.",
          ),
        );
    });
    deps.server.on("disconnected", message => disconnect(deps, notificationServer, message));
    deps.server.on("protocolError", (message) => deps.output.appendLine(message));
    await deps.server.start();
    if (deps.activeConnection.provider) await deps.activeConnection.provider.authenticate(deps.providerClient(deps.server, deps.activeConnection));
    deps.connections.assertCurrent(deps.activeConnection);
    await deps.refreshAccount();
    await deps.refreshCatalog();
    if(deps.cliPrepared && deps.server.executable===deps.cliPrepared.executable){deps.cliUpdates.accept(deps.cliPrepared.channel,deps.cliPrepared);deps.cliPrepared=null;}
    if(!deps.cliCheckRequest) (deps.setTimeout || setTimeout)(()=>{if(!deps.disposed)void deps.checkCliUpdates();},0);
    return deps.server;
  })().catch((error) => {
    deps.connecting = null;
    deps.server?.dispose();
    throw error;
  }).finally(() => { deps.connectionStarting = false; });
  return deps.connecting;
}

function notifySessions(deps, message) {
      for (const s of deps.sessions.values()) {
        const completion = deps.captureCompletion(s, message);
        // A duplicate/stale completion must not approve a different preparation turn.
        if(s.preflight?.enabled && message.method==='turn/completed' && message.params?.turn?.id!==s.turnId)continue;
        if (deps.notification(s, message)) {
          if(message.method==='item/completed' && message.params?.item?.type==='userMessage'){
            deps.questionRecords.restore(s);
          }
          if (message.method === "turn/completed") {
            deps.completionNotifications.dispatch(completion);
            if(s.preflight?.enabled)
              deps.preflight.finish(s.preflight,s.items,message.params.turn.id,message.params.turn.status,deps.hasPendingQuestions(s));
            deps.turnLeases.get(s.id)?.();
            deps.turnLeases.delete(s.id);
            s.lastTurnStatus=message.params.turn.status;
            deps.capacityRecovery?.completed(s,message);
            void deps.save(s);
            void deps.applyPendingMode(s).catch(error=>{s.error=error.message;deps.publish(s);});
            if(s.lastTurnStatus==='completed' && !s.stopRequested)void deps.drainFollowUps(s).catch(error=>{s.error=error.message;deps.publish(s);});
            if (!deps.isActive(s))
              void deps.library.update(s, { unread: true }).then(deps.broadcast);
          }
          deps.publish(s);
          if (!deps.hasChat(s) && !s.busy) deps.sessions.delete(s.key);
        }
      }
}


function disconnect(deps, notificationServer, message) {
      if (deps.server !== notificationServer) return;
      deps.capacityRecovery?.clear();
      if (deps.pendingLogin.current?.client === notificationServer) deps.pendingLogin.finish();
      deps.connecting = null;
      deps.limitsEpoch++;
      deps.limitsRequest = null;
      deps.limits = { buckets: [], loading: false, updatedAt: null, error: true };
      deps.pendingRequests.clear();
      for (const release of deps.turnLeases.values()) release();
      deps.turnLeases.clear();
      for (const s of deps.sessions.values()) {
        s.loaded = false;
        s.turnId = null;
        s.busy = false;
        // A compaction cut off by the crash will never report completion.
        s.compacting = false;
        s.error = message;
        deps.publish(s);
      }
      deps.output.appendLine(message);
}

module.exports = { connect, notifySessions, disconnect };
