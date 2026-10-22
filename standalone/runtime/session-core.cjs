// Session state and operations shared by the editor adapter and future Node hosts.
// Host callbacks return plain data; UI handles stay in the adapter. The mutable
// state surface is transitional while the remaining editor commands are extracted.
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { AppServer } = require('./transport.cjs');
const { PendingLogin } = require('./pending-login.cjs');
const { SessionStore } = require('./store.cjs');
const { SessionLibrary } = require('./library.cjs');
const { Connections } = require('./connections.cjs');
const { identity } = require('./account.cjs');
const { readCatalog } = require('./model-catalog.cjs');
const locale = require('../ui/i18n.js');
const preflight = require('./task-preflight.cjs');

function createSessionCore(host) {
  const clock = host.clock || { now: () => Date.now(), setTimeout, clearTimeout };
  const state = {
    loginId: undefined, server: undefined, connecting: undefined,
    catalog: [], account: undefined,
    limits: { buckets: [], loading: false, updatedAt: null, error: false },
    limitsEpoch: 0, limitsRequest: null, defaultModel: undefined, defaultEffort: undefined,
    authBusy: false, authOwner: null, activeConnection: null, connectionStarting: false,
    accountStatusRequest: null, cliPrepared: null, disposed: false,
    catalogRequest: null, catalogUpdatedAt: 0, accountReadRevision: 0, accountRequestEpoch: 0,
  };
  const sessions = new Map(), pendingRequests = new Map(), threadReleases = new Map(), turnLeases = new Map();
  const store = new SessionStore(path.join(host.paths.storage, 'sessions-v1'));
  const library = new SessionLibrary(host.workspaceState, store);
  const connections = new Connections({ store, activateOwner: host.activateConnectionOwner });
  const providerClients = new WeakMap();
  const broadcast = () => host.events.changed();
  const publish = s => host.events.sessionChanged(s);
  const cwd = () => host.defaultDirectory();
  // The dependency bridge is internal: modules see live state without receiving
  // the host's editor API, context, resource identifiers or presentation handles.
  const deps = {
    AppServer: host.createTransport || AppServer, PendingLogin, serviceMode:host.serviceMode===true,
    sessions, pendingRequests, threadReleases, turnLeases, store, library, connections,
    storagePath: host.paths.storage, workspaceState: host.workspaceState,
    settings: host.settings, trusted: host.trusted, editorSelection: host.editorSelection,
    hasChat: host.hasChat, isActive: host.isActive, target: host.activeSession,
    select: host.openChat, loadSelected: host.loadSelected,
    broadcast, publish, cwd, locale, preflight, fs, path, randomUUID,
    output: { appendLine: message => host.logger(message) },
    treeEvents: { fire: () => host.events.treeChanged() },
    notify: message => host.events.notify(message),
    completionNotifications: { dispatch: completion => host.events.completed(completion) },
    projectFiles: { clear: () => host.clearProjectFiles() },
    resolveCli: host.resolveCli, checkCliUpdates: host.checkCliUpdates,
    cliUpdates: { accept: (_channel, prepared) => host.acceptCli(prepared) },
    get cliCheckRequest() { return host.cliCheckPending(); },
    get mcpTasks() { return host.taskSessions(); },
    applyPendingMode: host.applyPendingMode, taskDirectory: require('./task-directory.cjs'),
    Date: { now: () => clock.now() }, setTimeout: (...args) => clock.setTimeout(...args),
    clearTimeout: (...args) => clock.clearTimeout(...args),
    providerClient, refreshAccount, refreshLimits, refreshCatalog, resetConnection, updateDraftModel, preparationConfig,
    onDeferredProviderRefresh:()=>host.onDeferredProviderRefresh?.(),
    deferProviderNotifications:host.deferProviderNotifications===true,
    asyncQuestions: require('./async-questions.cjs'), questionRecords: require('./question-records.cjs'),
    forms: require('../ui/forms.js'), modes: require('../ui/modes.js'), speed: require('../ui/speed.js'),
    buildInput: require('./input.cjs').buildInput,
    captureCompletion: require('./completion-notifications.cjs').capture,
    notification:(session,message)=>require('./session.cjs').notification(session,message,{serviceMode:host.serviceMode===true}), readItem: require('./session.cjs').readItem,
    acquireQueuedSession: require('./queued-session-transfer.cjs').acquireQueuedSession,
    assertQueueCurrent: require('./queued-edits.cjs').assertQueueCurrent,
  };
  for (const key of Object.keys(state)) Object.defineProperty(deps, key, {
    get: () => state[key], set: value => { state[key] = value; }, enumerable: true,
  });
  const operations = {};
  const modules = ['server-connection', 'session-persistence', 'session-resume', 'send-queue', 'question-policy', 'question-answer', 'session-actions', 'mcp-access'];
  for (const name of modules) for (const [key, operation] of Object.entries(require('./' + name + '.cjs')))
    operations[key] = deps[key] = (...args) => operation(deps, ...args);
  const browserSignInMessage = (...args) => require('./account-lifecycle.cjs').browserSignInMessage(deps, ...args);
  const pendingLogin = require('./account-lifecycle.cjs').createPendingLogin(deps);
  Object.assign(deps, { pendingLogin, browserSignInMessage });
  const { connect, save } = operations;
  deps.capacityRecovery=require('./model-capacity.cjs').createCapacityRecovery(deps);
  let nextDraft = 1;
  function createSession({ key = randomUUID(), saved = store.session(key) || host.workspaceState.get('session:' + key) || {}, inherited = {} } = {}) {
    const s = sessions.get(key) || {
      key, id: null, name: locale.t('Новая сессия {0}', nextDraft++),
      items: [], attachments: [], followUps: [], busy: false, cwd: cwd(),
      model: library.defaults.model, effort: library.defaults.effort,
      ...inherited, ...saved,
      prefs: { focus: false, showThinking: true, ide: false, plan: false, access: 'workspace', ...inherited.prefs, ...saved.prefs },
    };
    s.persistedRecord = saved;
    updateDraftModel(s);
    sessions.set(key, s);
    return s;
  }
  function providerClient(client, connection) {
    if (!providerClients.has(client)) {
      const assertOwner = () => {
        connections.assertCurrent(connection);
        if (state.server !== client) throw Error('The connection client has closed.');
      };
      providerClients.set(client, {
        async request(...args) { assertOwner(); const result = await client.request(...args); assertOwner(); return result; },
        respond(...args) { assertOwner(); return client.respond(...args); },
      });
    }
    return providerClients.get(client);
  }
  async function refreshAccount() {
    const client = state.server, requestEpoch = ++state.accountRequestEpoch;
    const previous = identity(state.account);
    const result = await client.request("account/read", { refreshToken: false });
    if (client !== state.server || requestEpoch !== state.accountRequestEpoch) return false;
    state.account = result.account
      ? {
          type: result.account.type,
          email: result.account.email,
          planType: result.account.planType,
        }
      : null;
    const changed = previous !== identity(state.account);
    if (changed) {
      state.catalog=[];state.catalogUpdatedAt=0;
      state.limitsEpoch++;
      state.limitsRequest = null;
      state.limits = { buckets: [], loading: false, updatedAt: null, error: false };
      for (const s of sessions.values()) if (!s.busy) s.loaded = false;
      void refreshLimits();
    }
    broadcast();
    state.accountReadRevision++;
    return changed;
  }
  async function withLocalSignIn(operation) {
    if (pendingLogin.current) throw Error(browserSignInMessage());
    if (state.authBusy || state.connectionStarting || state.accountStatusRequest || [...sessions.values()].some(session => session.busy || session.compacting || session.sendingTask))
      throw Error(locale.t('Дождитесь завершения задач перед сменой аккаунта.'));
    const release = store.acquire('account-credentials');
    try {
      store.assertNoActiveTurns();
      state.authOwner = release; state.authBusy = true; broadcast();
      return await operation(release);
    } finally {
      if (pendingLogin.current?.release !== release) {
        if (state.authOwner === release) { state.authOwner = null; state.authBusy = false; }
        release();
      }
      broadcast();
    }
  }
  function refreshAccountStatus() {
    if (state.authBusy) return Promise.reject(Error('Wait for the connection change to finish.'));
    if (state.accountStatusRequest) return state.accountStatusRequest;
    state.accountStatusRequest = (async () => {
      await connect();
      await refreshAccount();
      await Promise.all([refreshLimits(), refreshCatalog()]);
    })().finally(() => { state.accountStatusRequest = null; broadcast(); });
    return state.accountStatusRequest;
  }
  function stopAccountServer() {
    deps.capacityRecovery.clear();
    pendingLogin.finish();
    state.server?.removeAllListeners(); state.server?.dispose(); state.server = null; state.connecting = null;
  }
  async function resetConnection() {
    for (const session of sessions.values()) { await save(session); session.loaded = false; }
    stopAccountServer(); state.activeConnection = null;
    state.account = null; state.catalog = []; state.catalogUpdatedAt = 0;
    state.accountRequestEpoch++; state.limitsEpoch++; state.limitsRequest = null;
    state.limits = {buckets:[],loading:false,updatedAt:null,error:false};
    broadcast();
    return connect();
  }
  async function refreshLimits() {
    if (state.limitsRequest) return state.limitsRequest;
    if (!state.account || !["chatgpt", "chatgptAuthTokens"].includes(state.account.type)) {
      state.limits = { buckets: [], loading: false, updatedAt: null, error: false };
      broadcast();
      return;
    }
    const epoch = state.limitsEpoch,
      client = state.server;
    state.limits = { ...state.limits, loading: true };
    broadcast();
    state.limitsRequest = (async () => {
      try {
        const result = await client.request("account/rateLimits/read");
        if (epoch === state.limitsEpoch && client === state.server)
          state.limits = {
            buckets: require("../ui/limits.js").normalize(result),
            loading: false,
            updatedAt: clock.now(),
            error: false,
          };
      } catch {
        if (epoch === state.limitsEpoch && client === state.server)
          state.limits = { ...state.limits, loading: false, error: true };
      } finally {
        if (epoch === state.limitsEpoch && client === state.server) {
          state.limitsRequest = null;
          broadcast();
        }
      }
    })();
    return state.limitsRequest;
  }
  function updateDraftModel(s) {
    if(s.id || !state.catalog.length)return;
    if(!state.catalog.some(m=>m.model===s.model))
      s.model=[library.defaults.model,state.defaultModel,state.catalog[0]?.model].find(id=>state.catalog.some(m=>m.model===id));
    const model=state.catalog.find(m=>m.model===s.model);
    if(model && !model.supportedReasoningEfforts?.some(e=>e.reasoningEffort===s.effort))
      s.effort=[library.defaults.effort,state.defaultEffort,model.defaultReasoningEffort].find(e=>model.supportedReasoningEfforts?.some(v=>v.reasoningEffort===e));
  }
  async function refreshCatalog() {
    const client=state.server, accountId=identity(state.account), epoch=state.limitsEpoch;
    if(state.catalogRequest?.client===client && state.catalogRequest.epoch===epoch)return state.catalogRequest.promise;
    const request=(async()=>{
      const [available,config]=await Promise.all([
        readCatalog(client).catch(error=>{if(state.account)throw error;return [];}),
        client.request('config/read',{includeLayers:false}),
      ]);
      if(client!==state.server||identity(state.account)!==accountId||state.limitsEpoch!==epoch)return;
      state.catalog=available;state.catalogUpdatedAt=clock.now();
      state.defaultModel=config.config?.model || state.catalog.find(m=>m.isDefault)?.model;
      state.defaultEffort=config.config?.model_reasoning_effort;
      for(const s of sessions.values()){
        updateDraftModel(s);
        publish(s);
      }
    })();
    state.catalogRequest={client,epoch,promise:request};
    try{return await request;}finally{if(state.catalogRequest?.promise===request)state.catalogRequest=null;}
  }
  async function preparationConfig(s){
    const client=state.server;
    const result=await client.request('config/read',{includeLayers:false,cwd:s.cwd||cwd()});
    if(client!==state.server)throw Error(locale.t('Соединение изменилось. Повторите подготовку задачи.'));
    return preflight.restrictedConfig(result.config);
  }
  return {
    state, sessions, pendingRequests, threadReleases, turnLeases, store, library, connections, pendingLogin,
    ...operations, capacityRecovery:deps.capacityRecovery, createSession, browserSignInMessage, providerClient, refreshAccount, withLocalSignIn,
    refreshAccountStatus, stopAccountServer, resetConnection, refreshLimits, updateDraftModel, refreshCatalog, preparationConfig,
  };
}
module.exports = { createSessionCore };
