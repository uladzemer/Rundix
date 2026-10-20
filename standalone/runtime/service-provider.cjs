const {EventEmitter} = require('node:events');
const {spawn} = require('node:child_process');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {ProviderPeer, rpcError} = require('./service-provider-rpc.cjs');
const {readProviderConfig, configLocation, boundedRead, digest, actionRequired} = require('./service-provider-config.cjs');
const {DEADLINES, CAPABILITIES, helloParams, callbackOwner, UNAVAILABLE_CODES, equal, knownOutcome} = require('./service-provider-contract.cjs');
const {ServiceAppServer} = require('./service-cli.cjs');

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const identity = binding => binding && ({appServerId:binding.appServerId, appServerGeneration:binding.appServerGeneration, accountRevision:binding.accountRevision});
function unavailable(code, retryable = false, retryAfterMs = 0) {
  return {kind:'unavailable', code, retryable, retryAfterMs, messageKey:'provider.unavailable'};
}
function providerEnvironment(source) {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^(?:NODE_OPTIONS|NODE_PATH)$|^(?:OPENAI|CODEX|CHATGPT)_.*(?:AUTH|TOKEN|KEY|SECRET|PASSWORD)/i.test(key)));
}

// The public service, never the provider child, owns all grants and turn state.
// Callback authorization is tied to the exact live parent RPC and its deadline.
class ServiceProvider extends EventEmitter {
  #options; #config = null; #peer = null; #child = null; #start = null; #lost = true;
  #parents = new Map(); #idle = null; #account = null; #grants = new Map(); #turns = new Map(); #waits = new Map();
  #retiredWaits = new Map();
  #preparing = false; #authenticating = null; #selectionRevision = 1; #disposed = false;
  #configurationPending = null;
  #providerGeneration = randomUUID(); #cli = null;
  #dispatchAuthorization = null;
  constructor({serviceGeneration, ...options} = {}) {
    super();
    if (typeof serviceGeneration !== 'string' || !serviceGeneration) throw actionRequired();
    this.serviceGeneration = serviceGeneration; this.#options = options;
  }
  get authority() {
    if (!this.#config) throw actionRequired('PROVIDER_NOT_CONFIGURED');
    return {serviceGeneration:this.serviceGeneration, configRevision:this.#config.configRevision, providerGeneration:this.#providerGeneration};
  }
  get cli() { return this.#cli; }
  get activeTurns() { return this.#turns.size; }
  get busy() { return this.#parents.size > 0 || this.#turns.size > 0 || !!this.#idle || !!this.#configurationPending; }
  get accountGrant() { return this.#account ? structuredClone(this.#account) : null; }
  async start() {
    if (this.#disposed || (this.#lost && this.#start)) throw actionRequired('PROVIDER_PROCESS_UNCERTAIN');
    if (this.#start) return this.#start;
    this.#config = readProviderConfig(this.#options);
    const authority = this.authority;
    this.#start = (async () => {
      const child = (this.#options.spawnProcess || spawn)(this.#options.nodePath || process.execPath, [this.#config.entryPath],
        {cwd:path.dirname(this.#config.entryPath), env:providerEnvironment(this.#options.env || process.env),
          shell:false, windowsHide:true, stdio:['pipe', 'pipe', 'pipe']});
      this.#child = child; this.#lost = false;
      // Provider stderr is never a diagnostics channel for the public service.
      child.stderr.resume(); child.on('error', () => this.#lose()); child.on('close', () => this.#lose());
      const peer = new ProviderPeer({readable:child.stdout, writable:child.stdin,
        call:(method, params, context) => this.#callback(peer, method, params, context)});
      this.#peer = peer; peer.on('closed', () => this.#lose());
      peer.on('event', (method, params, fence) => {
        if (method !== 'connectionChanged' || !this.#globalCurrent(fence)) { this.#lose(); return; }
        this.#lose('connection_changed');
      });
      const result = await this.#call('hello', helloParams(this.#config.provider), {fence:authority});
      if (!isObject(result) || result.version?.major !== 2 || result.version?.minor !== 0 ||
          result.providerId !== this.#config.provider.id || result.providerVersion !== this.#config.provider.version ||
          !Array.isArray(result.capabilities) || !CAPABILITIES.every(name => result.capabilities.includes(name))) throw actionRequired('PROVIDER_INCOMPATIBLE');
      return this;
    })().catch(error => { this.#lose(); throw error?.reason === 'action_required' ? error : actionRequired('PROVIDER_UNAVAILABLE'); });
    return this.#start;
  }
  createCli(options = {}) {
    if (this.#lost || this.#cli) throw actionRequired('PROVIDER_UNAVAILABLE');
    const cli = (this.#options.createCli || (opts => new ServiceAppServer(opts)))({...options, authority:this.authority});
    this.#cli = cli;
    cli.installTurnAuthorizer(({method, params}) => {
      const authorization = this.#dispatchAuthorization;
      if (!authorization || authorization.method !== method || authorization.params !== params ||
          this.#turns.get(authorization.grant.leaseId) !== authorization.grant) throw rpcError('STALE_FENCE');
    });
    cli.on('request', request => {
      if (request.method === 'account/chatgptAuthTokens/refresh') {
        void this.handleRequest(request).catch(() => {
          if (this.#cli === cli) { cli.respond(request.id, null, {code:-32000, message:'Provider access is unavailable.'}); cli.invalidateProvider(); }
        });
      }
    });
    cli.on('disconnected', () => {
      // CLI exit is not inferred from a disconnect. Active/uncertain grants stay
      // reserved until terminal() or the verified restart barrier completes.
      this.#account = null; this.emit('connectionChanged', {reason:'connection_changed'});
    });
    return cli;
  }
  #globalCurrent(fence) {
    return !!fence && !this.#lost && ['serviceGeneration', 'providerGeneration', 'configRevision'].every(key => fence[key] === this.authority[key]);
  }
  #checkConfig() {
    try {
      if (digest(boundedRead(this.#options.configPath || configLocation(), 16384)) !== this.#config.configSha256) throw actionRequired();
    } catch { this.#lose('connection_changed'); throw actionRequired(); }
  }
  #lose(reason = 'action_required') {
    if (this.#lost) return;
    this.#lost = true; this.#cli?.invalidateProvider();
    for (const parent of this.#parents.values()) { parent.active = false; parent.transaction?.close(); }
    this.#peer?.close(); this.#child?.kill();
    // Do not release turns on provider timeout/disconnect. CLI may still work.
    this.emit('connectionChanged', {reason});
  }
  #event(method, params, fence = this.#cli?.fence || this.authority) {
    if (this.#lost) return;
    this.#peer.event(method, params, fence);
  }
  #grant(kind, binding, extra = {}) {
    const leaseId = randomUUID();
    const grant = {kind, leaseId, leaseRevision:1, ...extra, binding:structuredClone(kind === 'turn' ? binding : {...binding, leaseId, leaseRevision:1})};
    this.#grants.set(grant.leaseId, grant); this.#event('lease/grant', {grant}); return grant;
  }
  #revoke(grant) {
    if (!grant || this.#grants.get(grant.leaseId) !== grant) return;
    this.#grants.delete(grant.leaseId); this.#event('lease/revoke', {leaseId:grant.leaseId, leaseRevision:grant.leaseRevision});
  }
  #acquireIdle() {
    if (this.#turns.size || this.#idle) throw actionRequired('BUSY_ACTIVE');
    const grant = this.#grant('idle', this.#cli.binding); this.#idle = grant; return grant;
  }
  #restoreAccount() {
    if (this.#idle || !this.#account || !this.#cli?.authenticated || !equal(identity(this.#account.binding), identity(this.#cli.binding))) return;
    this.#cli.useAccountGrant({...this.#account, ...identity(this.#account.binding)});
  }
  async #call(method, params, {fence = this.#cli?.fence || this.authority, idle = null, transaction = null, timeoutMs, selection = false} = {}) {
    if (this.#lost || !DEADLINES[method]) throw actionRequired('PROVIDER_UNAVAILABLE');
    this.#checkConfig();
    const budget = Math.min(timeoutMs ?? DEADLINES[method], DEADLINES[method]);
    const parent = {active:true, deadline:Date.now() + budget, method, fence:structuredClone(fence), idle, transaction,
      selectionRevision:this.#selectionRevision, proposed:null, callbackBusy:false};
    try {
      const envelope = await this.#peer.request(method, params, fence, budget, {onRequest:id => { parent.id = id; this.#parents.set(id, parent); }});
      if (!parent.active || !this.#globalCurrent(fence) || !equal(envelope.fence, parent.fence) ||
          (selection && parent.selectionRevision !== this.#selectionRevision)) throw rpcError('STALE_FENCE');
      const result = envelope.result;
      if (!isObject(result)) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
      if (!['hello', 'status'].includes(method) && !knownOutcome(result)) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
      const outcomes = {authenticate:['authenticated', 'unavailable'], prepareTurn:['ready', 'waitUntil', 'needsDecision', 'unavailable'],
        handleRequest:['cliResponse', 'unavailable'], cancelWait:['cancelled'], configureByClient:['configured', 'pending', 'unavailable'], dispose:['disposed']};
      if (outcomes[method] && !outcomes[method].includes(result.kind)) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
      if (method === 'configureByClient') {
        if (result.kind === 'pending') {
          if (typeof result.operationId !== 'string' || !result.operationId || result.operationId.length > 128) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
          this.#configurationPending = {operationId:result.operationId}; this.#cli.invalidateProvider();
        }
        if (result.kind === 'configured' && result.selectionRevision !== this.#selectionRevision + 1) throw rpcError('INVALID_REVISION_STEP');
      }
      if (result.effectiveBinding && (!parent.transaction || !equal(result.effectiveBinding, parent.transaction.fence.binding))) throw rpcError('STALE_FENCE');
      if (method === 'authenticate' && result.kind === 'unavailable') {
        if (!UNAVAILABLE_CODES.includes(result.code)) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
        throw actionRequired(result.code);
      }
      if (parent.transaction?.loggedIn) {
        if (!['authenticated', 'ready'].includes(result.kind)) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
        const initial = parent.transaction.fence.binding.accountRevision;
        if (!revision(result.accountRevision) || ![initial, initial + 1].includes(result.accountRevision) || !result.accountRevision) throw rpcError('INVALID_REVISION_STEP');
        parent.transaction.complete({kind:'authenticated', accountRevision:result.accountRevision, fence:parent.transaction.fence});
        parent.transaction.close(); parent.transaction = null;
        let account = this.#account && equal(identity(this.#account.binding), identity(this.#cli.binding)) ? this.#account : parent.proposed;
        if (account === this.#account) this.#revoke(parent.proposed);
        else this.#revoke(this.#account);
        if (!account || account.binding.accountRevision !== result.accountRevision) {
          this.#revoke(account); account = this.#grant('account', this.#cli.binding);
        }
        account.provisional = false; this.#event('lease/grant', {grant:account});
        this.#account = account; parent.proposed = null; this.#restoreAccount();
      } else if (method === 'authenticate') throw actionRequired('PROVIDER_PROTOCOL_INVALID');
      return result;
    } catch (error) {
      this.#cli?.invalidateProvider();
      if (['STALE_FENCE', 'INVALID_REVISION_STEP', 'METHOD_NOT_SUPPORTED'].includes(error?.code)) throw error;
      throw error?.reason === 'action_required' ? error : actionRequired('PROVIDER_UNAVAILABLE');
    } finally {
      parent.active = false; parent.transaction?.close(); this.#revoke(parent.proposed); this.#parents.delete(parent.id);
      if (parent.idle && this.#idle === parent.idle) { this.#revoke(parent.idle); this.#idle = null; }
      this.#restoreAccount();
    }
  }
  async #callback(peer, method, params, context) {
    if (peer !== this.#peer || !this.#globalCurrent(context.fence)) throw rpcError('STALE_FENCE');
    this.#checkConfig();
    const parent = this.#parents.get(params.parentRequestId);
    const currentFence = parent?.transaction ? {...parent.fence, binding:parent.transaction.fence.binding} : parent?.fence;
    const current = () => parent?.active && !context.signal.aborted && Date.now() < parent.deadline && !this.#lost &&
      this.#parents.get(params.parentRequestId) === parent && this.#globalCurrent(context.fence);
    if (!current() || !equal(context.fence, currentFence) || !equal(params.binding, currentFence.binding) ||
        !equal(params.owner, callbackOwner(currentFence.binding)) || context.deadline > parent.deadline + 25) throw rpcError('STALE_FENCE');
    if (!['cli/request', 'cli/reconnect'].includes(method)) throw rpcError('METHOD_NOT_SUPPORTED');
    if (parent.callbackBusy) throw rpcError('METHOD_NOT_SUPPORTED');
    parent.callbackBusy = true;
    try {
      if (method === 'cli/reconnect') {
        if (!parent.idle || params.idleGrantId !== parent.idle.leaseId || this.#idle !== parent.idle || this.#turns.size || !parent.transaction) throw rpcError('METHOD_NOT_SUPPORTED');
        parent.transaction.close(); this.#cli.dispose(); await this.#cli.start();
        if (!current()) throw rpcError('STALE_FENCE');
        this.#revoke(this.#account); this.#account = null;
        this.#revoke(parent.idle); parent.idle = this.#grant('idle', this.#cli.binding); this.#idle = parent.idle;
        parent.transaction = this.#cli.beginProviderTransaction({...parent.idle, timeoutMs:Math.max(1, parent.deadline - Date.now())});
        return {confirmedExit:true, effectiveBinding:parent.transaction.fence.binding};
      }
      if (!['account/login/start', 'account/read', 'account/rateLimits/read'].includes(params.method) || !isObject(params.params)) throw rpcError('METHOD_NOT_SUPPORTED');
      const allowed = params.method === 'account/login/start' ? ['type', 'accessToken', 'chatgptAccountId', 'chatgptPlanType']
        : params.method === 'account/read' ? ['refreshToken'] : [];
      if (Object.keys(params.params).some(key => !allowed.includes(key))) throw rpcError('METHOD_NOT_SUPPORTED');
      const budget = Math.min(70000, context.deadline - Date.now(), parent.deadline - Date.now());
      if (budget < 1) throw rpcError('STALE_FENCE');
      if (params.method === 'account/login/start' && (!parent.idle || params.idleGrantId !== parent.idle.leaseId || this.#idle !== parent.idle || this.#turns.size || !parent.transaction || params.params.type !== 'chatgptAuthTokens')) throw rpcError('METHOD_NOT_SUPPORTED');
      const result = parent.transaction ? await parent.transaction.request(params.method, params.params, budget)
        : await this.#cli.request(params.method, params.params, budget);
      if (!current()) throw rpcError('STALE_FENCE');
      if (params.method === 'account/login/start') {
        this.#revoke(parent.proposed);
        parent.proposed = this.#grant('account', {...this.#cli.binding, accountRevision:this.#cli.binding.accountRevision + 1}, {provisional:true});
        return {response:result, authGrantId:parent.proposed.leaseId, nextAccountRevision:parent.proposed.binding.accountRevision};
      }
      return {response:result};
    } finally { parent.callbackBusy = false; }
  }
  async authenticate(trigger = 'initial') {
    if (this.#authenticating) return this.#authenticating;
    if (this.#configurationPending) throw actionRequired('CLIENT_REQUIRED');
    if (!this.#cli || this.#lost || !['initial', 'reconnect', 'catalog'].includes(trigger)) throw actionRequired('PROVIDER_UNAVAILABLE');
    if (this.#account && this.#cli.authenticated && equal(identity(this.#account.binding), identity(this.#cli.binding))) return {kind:'authenticated', accountRevision:this.#account.binding.accountRevision};
    this.#authenticating = (async () => {
      const idle = this.#acquireIdle();
      let transaction;
      try { transaction = this.#cli.beginProviderTransaction({...idle, timeoutMs:70000}); }
      catch (error) { this.#revoke(idle); this.#idle = null; throw error; }
      return this.#call('authenticate', {appServerId:this.#cli.binding.appServerId, trigger}, {idle, transaction, fence:transaction.fence});
    })();
    try { return await this.#authenticating; } finally { this.#authenticating = null; }
  }
  async prepareTurn(task, {mode = 'admit'} = {}) {
    if (!['admit', 'probe'].includes(mode) || !task || !['taskId', 'spaceId', 'attemptId'].every(key => typeof task[key] === 'string' && task[key])) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
    if (this.#preparing || this.#idle || this.#configurationPending) return unavailable('BUSY_ACTIVE', true);
    if (this.#lost || !this.#account || !this.#cli?.authenticated) throw actionRequired('AUTH_REQUIRED');
    this.#preparing = true;
    let idle, transaction;
    const waitId = task.waitId || randomUUID();
    try {
      if (this.#retiredWaits.has(waitId)) throw rpcError('STALE_FENCE');
      if (this.#waits.has(waitId) && !equal(this.#waits.get(waitId), {taskId:task.taskId, spaceId:task.spaceId})) throw rpcError('STALE_FENCE');
      this.#waits.set(waitId, {taskId:task.taskId, spaceId:task.spaceId});
      if (!this.#turns.size && !this.#idle) {
        idle = this.#acquireIdle(); transaction = this.#cli.beginProviderTransaction({...idle, timeoutMs:90000});
      }
      const base = transaction?.fence || this.#cli.fence;
      const fence = {...base, admission:{selectionRevision:this.#selectionRevision}};
      // The transaction's binding is checked separately; admission belongs only
      // to the prepare envelope, never active-turn refresh.
      const result = await this.#call('prepareTurn', {...task, waitId, mode, interactiveClientAvailable:false}, {fence, idle, transaction, selection:true});
      if (!this.#waits.has(waitId)) return {kind:'cancelled', waitId};
      if (result.kind === 'ready') {
        if (result.accountRevision !== this.#account?.binding.accountRevision || result.authGrantId !== this.#account?.leaseId ||
            typeof result.limitsSnapshotId !== 'string' || !result.limitsSnapshotId || !Number.isFinite(result.validUntil) || result.validUntil <= Date.now()) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
        if (mode === 'probe') {
          if (!revision(result.checkRevision)) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
          return {kind:'ready', limitsSnapshotId:result.limitsSnapshotId, checkRevision:result.checkRevision};
        }
        const grant = this.#grant('turn', this.#cli.binding, {taskId:task.taskId, spaceId:task.spaceId,
          runId:task.runId || randomUUID(), attemptId:task.attemptId, validUntil:result.validUntil, state:'reserved'});
        this.#turns.set(grant.leaseId, grant); this.#retiredWaits.set(waitId, this.#waits.get(waitId)); this.#waits.delete(waitId);
        return {...result, grant:structuredClone(grant)};
      }
      if (result.kind === 'waitUntil') {
        if (result.waitId !== waitId || ![null, 'number'].some(type => type === null ? result.resetAt === null : typeof result.resetAt === type && Number.isFinite(result.resetAt)) ||
            !['low_remaining', 'exhausted'].includes(result.reason)) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
        return result;
      }
      if (result.kind === 'unavailable' && UNAVAILABLE_CODES.includes(result.code) && typeof result.retryable === 'boolean' &&
          Number.isFinite(result.retryAfterMs) && result.retryAfterMs >= 0 && typeof result.messageKey === 'string') {
        if (!['LIMITS_UNKNOWN', 'RESET_UNKNOWN', 'BUSY_ACTIVE'].includes(result.code)) this.#cli.invalidateProvider();
        return {...result, waitId};
      }
      // No interactive decision is legal in stage-1 MCP, even with an open UI.
      throw actionRequired('PROVIDER_PROTOCOL_INVALID');
    } catch (error) { this.#cli?.invalidateProvider(); throw error; }
    finally {
      transaction?.close();
      if (idle && this.#idle === idle) { this.#revoke(idle); this.#idle = null; }
      this.#restoreAccount(); this.#preparing = false;
    }
  }
  async dispatchTurn(grant, params) {
    this.#checkConfig();
    const owned = this.#turns.get(grant?.leaseId);
    if (!owned || !equal(owned, grant) || owned.state !== 'reserved' || owned.validUntil <= Date.now() ||
        !equal(identity(owned.binding), identity(this.#cli?.binding)) || !this.#cli.authenticated || this.#lost) throw rpcError('STALE_FENCE');
    owned.state = 'dispatching';
    try {
      let pending;
      try {
        this.#dispatchAuthorization = {grant:owned, method:'turn/start', params};
        pending = this.#cli.request('turn/start', params);
      } finally { this.#dispatchAuthorization = null; }
      const result = await pending;
      if (!result?.turn?.id || typeof result.turn.id !== 'string') throw actionRequired('PROVIDER_PROTOCOL_INVALID');
      if (this.#lost) { owned.turnId = result.turn.id; throw Object.assign(actionRequired('PROVIDER_UNAVAILABLE'), {deliveryUncertain:true}); }
      owned.state = 'active'; owned.turnId = result.turn.id;
      this.#event('turnStarted', {taskId:owned.taskId, spaceId:owned.spaceId, runId:owned.runId,
        turnId:owned.turnId, turnLeaseId:owned.leaseId});
      return result;
    } catch (error) {
      if (error.deliveryUncertain === false) { this.#turns.delete(owned.leaseId); this.#revoke(owned); }
      else owned.state = 'uncertain';
      throw error;
    }
  }
  terminal({turnLeaseId, taskId, runId, turnId, trigger = 'terminal'}) {
    const grant = this.#turns.get(turnLeaseId);
    if (!grant || grant.taskId !== taskId || grant.runId !== runId || grant.turnId !== turnId || !['terminal', 'confirmedCliExit'].includes(trigger)) throw rpcError('STALE_FENCE');
    this.#event('turnTerminal', {taskId, spaceId:grant.spaceId, runId, turnId, turnLeaseId, trigger});
    this.#turns.delete(turnLeaseId); this.#revoke(grant); this.emit('idle');
  }
  releaseReserved(grant) {
    const owned = this.#turns.get(grant?.leaseId);
    if (!owned || owned.state !== 'reserved' || !equal(owned, grant)) throw rpcError('STALE_FENCE');
    this.#turns.delete(owned.leaseId); this.#revoke(owned); this.emit('idle');
  }
  async cancelWait({waitId, taskId, spaceId}) {
    const retired = this.#retiredWaits.get(waitId);
    if (retired) {
      if (!equal(retired, {taskId, spaceId})) throw rpcError('STALE_FENCE');
      return {kind:'cancelled', waitId};
    }
    const wait = this.#waits.get(waitId);
    if (wait && !equal(wait, {taskId, spaceId})) throw rpcError('STALE_FENCE');
    this.#retiredWaits.set(waitId, {taskId, spaceId}); this.#waits.delete(waitId);
    const result = await this.#call('cancelWait', {waitId});
    if (result.kind !== 'cancelled' || result.waitId !== waitId) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
    return result;
  }
  async handleRequest(request) {
    if (request?.method !== 'account/chatgptAuthTokens/refresh' || this.#lost || !this.#cli) throw rpcError('METHOD_NOT_SUPPORTED');
    const cli = this.#cli, fence = cli.fence;
    if (!cli.claimProviderRequest(request)) return false;
    // This does not acquire the prepare mutex or idle grant. A busy prepare can
    // require refresh itself; serializing them would deadlock authorization.
    const result = await this.#call('handleRequest', {request}, {fence});
    if (result.kind !== 'cliResponse' || result.requestId !== request.id || !isObject(result.response) ||
        !['accessToken', 'chatgptAccountId'].every(key => typeof result.response[key] === 'string' && !!result.response[key]) ||
        (result.response.chatgptPlanType !== undefined && typeof result.response.chatgptPlanType !== 'string') ||
        Object.keys(result.response).some(key => !['accessToken', 'chatgptAccountId', 'chatgptPlanType'].includes(key)) || !equal(cli.fence, fence)) throw rpcError('STALE_FENCE');
    return cli.respondProvider(request.id, result.response, fence);
  }
  async configureByClient(params) {
    if (this.#turns.size || this.#idle || this.#preparing || this.#configurationPending || params.expectedSelectionRevision !== this.#selectionRevision) throw rpcError('STALE_FENCE');
    const idle = this.#acquireIdle();
    let transaction;
    try {
      transaction = this.#cli.beginProviderTransaction({...idle, timeoutMs:15000});
      const result = await this.#call('configureByClient', params, {idle, transaction, fence:transaction.fence});
      if (!['configured', 'pending', 'unavailable'].includes(result.kind)) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
      if (result.kind === 'configured') { this.#selectionRevision++; return {...result, selectionRevision:this.#selectionRevision}; }
      return result;
    } finally {
      transaction?.close(); if (this.#idle === idle) { this.#revoke(idle); this.#idle = null; this.#restoreAccount(); }
    }
  }
  async status(params = {}) {
    const result = await this.#call('status', params);
    if (result.kind !== undefined) {
      if (!knownOutcome(result) || !['pending', 'succeeded', 'failed', 'uncertain'].includes(result.kind) ||
          typeof result.operationId !== 'string' || !result.operationId ||
          (result.code !== undefined && !UNAVAILABLE_CODES.includes(result.code))) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
      if (this.#configurationPending?.operationId === result.operationId && params.operationId === result.operationId &&
          ['succeeded', 'failed'].includes(result.kind)) {
        this.#configurationPending = null;
        if (result.kind === 'succeeded') this.#selectionRevision++;
      }
      return {kind:result.kind, operationId:result.operationId, ...(result.code ? {code:result.code} : {})};
    }
    if (typeof result.authenticated !== 'boolean' || !revision(result.activeTurns) || typeof result.preparing !== 'boolean' ||
        Object.keys(result).some(key => !['authenticated', 'activeTurns', 'preparing', 'counts'].includes(key)) ||
        (result.counts !== undefined && (!isObject(result.counts) || Object.entries(result.counts).some(([key, count]) =>
          ![...Object.keys(DEADLINES), 'turnStarted', 'turnTerminal'].includes(key) || !revision(count))))) throw actionRequired('PROVIDER_PROTOCOL_INVALID');
    return {authenticated:result.authenticated, activeTurns:result.activeTurns, preparing:result.preparing,
      ...(result.counts ? {counts:{...result.counts}} : {})};
  }
  async dispose(trigger = 'serviceShutdown') {
    if (this.#disposed) return;
    if (this.#turns.size || this.#preparing || this.#idle) throw actionRequired('BUSY_ACTIVE');
    this.#disposed = true;
    try { if (!this.#lost) await this.#call('dispose', {trigger, mode:'drain'}); }
    finally { this.#cli?.dispose(); this.#peer?.close(); this.#child?.kill(); }
  }
}
module.exports = {ServiceProvider};
