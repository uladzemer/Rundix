// Service-only safety boundary. The window transport is intentionally unchanged.
// This does not implement provider v2 admission/grants: its trusted caller must
// supply the installed-provider callback and still admit every turn separately.
const {EventEmitter} = require('node:events');
const {randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const {AppServer} = require('./transport.cjs');

const METHODS = new Set(['model/list', 'config/read', 'account/read',
  'account/rateLimits/read', 'thread/start', 'thread/resume', 'thread/read',
  'thread/turns/list', 'thread/items/list', 'thread/name/set', 'thread/unsubscribe', 'turn/start',
  'turn/steer', 'turn/interrupt', 'thread/compact/start']);
const MODEL_METHODS = new Set(['turn/start', 'turn/steer', 'thread/compact/start']);
const PROVIDER_METHODS = new Set(['account/login/start', 'account/read', 'account/rateLimits/read']);
function unavailable(reason = 'action_required') {
  return Object.assign(Error('Provider sign-in required. Open connection settings and reconnect.'),
    {code:'connection_unavailable', reason, deliveryUncertain:false});
}
function rejected(error) {
  return Object.assign(Error('CLI request failed.'), {code:'rejected', deliveryUncertain:error?.deliveryUncertain !== false});
}
const {serviceEnvironment:environment} = require('./service-environment.cjs');
function safeRevision(value) { return Number.isSafeInteger(value) && value >= 0; }
function sameFence(a, b) {
  if (!a || !b) return false;
  return ['serviceGeneration', 'configRevision', 'providerGeneration'].every(key => a[key] === b[key]) &&
    ['appServerId', 'appServerGeneration', 'accountRevision', 'leaseId', 'leaseRevision']
      .every(key => a.binding?.[key] === b.binding?.[key]);
}

class ServiceAppServer extends EventEmitter {
  #cli = null; #starting = null; #authenticated = false; #auth = null;
  #binding = null; #epoch = 0; #options; #authority;
  #authUncertain = false;
  #exit = null;
  #ready = false;
  #requests = new Map();
  #claimedRequests = new Set();
  #confirmedAccountId = null;
  #turnAuthorizer = null;
  constructor({authority, executable, cwd, env = process.env, spawnProcess, configArgs = []} = {}) {
    super();
    if (!authority || !safeRevision(authority.configRevision) ||
        !['serviceGeneration', 'providerGeneration'].every(key => typeof authority[key] === 'string' && authority[key].length > 0))
      throw unavailable();
    // Accept only the existing session core's fixed feature override. No caller
    // can append a credential-store override or a persistent-login option.
    if (configArgs.length && (configArgs.length !== 2 || configArgs[0] !== '-c' ||
        configArgs[1] !== 'features.default_mode_request_user_input=true')) throw unavailable();
    this.#authority = {serviceGeneration:authority.serviceGeneration,
      configRevision:authority.configRevision, providerGeneration:authority.providerGeneration};
    this.#options = {executable, cwd, env:environment(env), spawnProcess:(...args) => {
      const child = (spawnProcess || spawn)(...args);
      this.#exit = new Promise(resolve => child.once('close', resolve));
      return child;
    },
      configArgs:[...configArgs, '-c', 'cli_auth_credentials_store="ephemeral"']};
    this.executable = executable;
  }
  get binding() { return this.#binding ? {...this.#binding} : null; }
  get authenticated() { return this.#authenticated; }
  get fence() { return {...this.#authority, binding:this.binding}; }
  invalidateProvider() {
    this.#authenticated = false;
    if (this.#auth) {
      // A timed-out login may still replace CLI auth later. Never allow a new
      // proof on this process while that mutation's outcome is ambiguous.
      if (this.#auth.loginPending) this.#authUncertain = true;
      this.#auth.active = false; this.#auth.abort?.(); this.#auth = null;
    }
  }
  start() {
    if (this.#starting) return this.#starting;
    const epoch = ++this.#epoch;
    let cli;
    this.#starting = (async () => {
      // dispose()/transport failure requests a stop; only the close event proves
      // it. Never create a replacement process while a prior one may be alive.
      if (this.#exit) {
        let timer;
        try {
          await Promise.race([this.#exit, new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(Error('CLI recovery required.'), {code:'recovery_required'})), 5000);
          })]);
        } finally { clearTimeout(timer); }
      }
      if (this.#epoch !== epoch) throw unavailable('connection_changed');
      this.invalidateProvider(); this.#authUncertain = false; this.#ready = false; this.#confirmedAccountId = null;
      cli = new AppServer(this.#options); this.#cli = cli;
      this.#binding = {appServerId:randomUUID(), appServerGeneration:randomUUID(),
        accountRevision:0, leaseId:randomUUID(), leaseRevision:1};
      cli.on('disconnected', () => {
        if (this.#cli !== cli) return;
        this.invalidateProvider(); this.#requests.clear(); this.#claimedRequests.clear(); this.#ready = false; this.#cli = null; this.#starting = null;
        this.emit('disconnected', 'CLI disconnected. Reconnect the provider.');
      });
      cli.on('protocolError', () => { if (this.#cli === cli) this.emit('protocolError', 'CLI protocol error.'); });
      for (const event of ['notification', 'request']) cli.on(event, message => {
        if (this.#cli !== cli) return;
        if (event === 'request') this.#requests.set(String(message.id), message);
        if (event === 'notification' && message.method === 'serverRequest/resolved') {
          this.#requests.delete(String(message.params?.requestId)); this.#claimedRequests.delete(String(message.params?.requestId));
        }
        this.emit(event, message);
      });
      const result = await cli.start();
      if (this.#cli !== cli || this.#epoch !== epoch) throw unavailable('connection_changed');
      this.#ready = true;
      return result;
    })().catch(error => {
      if (this.#epoch === epoch) {
        this.invalidateProvider(); this.#requests.clear(); this.#claimedRequests.clear(); this.#ready = false; this.#cli = null; this.#starting = null; cli?.dispose();
      }
      if (error.code === 'recovery_required') throw error;
      throw rejected(error);
    });
    return this.#starting;
  }
  async #request(cli, method, params, timeoutMs) {
    if (this.#cli !== cli || !cli) throw unavailable('connection_changed');
    try {
      const result = await cli.request(method, params, timeoutMs);
      if (this.#cli !== cli) throw Object.assign(unavailable('connection_changed'), {deliveryUncertain:true});
      return result;
    } catch (error) {
      if (this.#cli !== cli) throw Object.assign(unavailable('connection_changed'), {deliveryUncertain:true});
      throw rejected(error);
    }
  }
  async request(method, params = {}, timeoutMs = 30000) {
    if (!METHODS.has(method)) return Promise.reject(Object.assign(Error('CLI method is unsupported.'), {code:'METHOD_NOT_SUPPORTED', deliveryUncertain:false}));
    if (!this.#ready) throw unavailable();
    if (MODEL_METHODS.has(method) && !this.#authenticated) return Promise.reject(unavailable());
    if (MODEL_METHODS.has(method)) {
      try { this.#turnAuthorizer?.({method, params}); }
      catch (error) { throw Object.assign(error, {deliveryUncertain:false}); }
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 90000) return Promise.reject(unavailable());
    const fence = this.fence;
    const result = await this.#request(this.#cli, method, params, timeoutMs);
    if (!sameFence(fence, this.fence)) throw Object.assign(unavailable('connection_changed'), {deliveryUncertain:true});
    return result;
  }
  installTurnAuthorizer(authorize) {
    if (this.#turnAuthorizer || typeof authorize !== 'function') throw unavailable();
    this.#turnAuthorizer = authorize;
  }
  beginProviderTransaction({leaseId, leaseRevision, timeoutMs = 90000} = {}) {
    if (!this.#ready || !this.#cli || !this.#binding || this.#auth || this.#authUncertain ||
        typeof leaseId !== 'string' || !leaseId || !safeRevision(leaseRevision) || leaseRevision < 1 ||
        !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 90000) throw unavailable();
    this.#binding = {...this.#binding, leaseId, leaseRevision};
    const cli = this.#cli, fence = this.fence, deadline = Date.now() + timeoutMs;
    const auth = {active:true, loggedIn:false, loginPending:0, mutated:false, completed:false, accountId:null, changedAccount:false}; this.#auth = auth;
    const current = () => auth.active && this.#auth === auth && this.#cli === cli && sameFence(this.fence, fence);
    const invalidated = new Promise((_, reject) => { auth.abort = () => reject(unavailable('connection_changed')); });
    invalidated.catch(() => {});
    const request = async (method, params = {}, budget = 70000) => {
      if (!current()) throw unavailable('connection_changed');
      if (!PROVIDER_METHODS.has(method) || (method === 'account/login/start' && params.type !== 'chatgptAuthTokens'))
        throw Object.assign(Error('CLI method is unsupported.'), {code:'METHOD_NOT_SUPPORTED', deliveryUncertain:false});
      if (method === 'account/login/start' && (!['accessToken', 'chatgptAccountId'].every(key => typeof params[key] === 'string' && !!params[key]))) throw unavailable();
      if (!Number.isFinite(budget) || budget <= 0 || budget > 70000) throw unavailable();
      const remaining = Math.min(budget, deadline - Date.now());
      if (remaining <= 0) throw unavailable();
      const loginRequest = method === 'account/login/start';
      if (loginRequest) {
        auth.loginPending++; auth.mutated = true; this.#authenticated = false;
        auth.accountId = params.chatgptAccountId;
        auth.changedAccount ||= params.chatgptAccountId !== this.#confirmedAccountId;
      }
      let result;
      try { result = await this.#request(cli, method, params, remaining); }
      catch (error) {
        if (loginRequest && error.deliveryUncertain && this.#cli === cli) this.#authUncertain = true;
        throw error;
      } finally { if (loginRequest) auth.loginPending--; }
      if (!current()) throw unavailable('connection_changed');
      if (loginRequest) {
        if (result?.type !== 'chatgptAuthTokens') throw unavailable();
        auth.loggedIn = true; auth.accountId = params.chatgptAccountId;
      }
      return result;
    };
    return {
      fence:structuredClone(fence), request, invalidated, current,
      get loggedIn() { return auth.loggedIn; },
      // Internal evidence only; non-ready admission outcomes carry no revision.
      get confirmedAccountRevision() {
        return auth.loggedIn && !auth.loginPending
          ? fence.binding.accountRevision + (auth.changedAccount ? 1 : 0) : null;
      },
      complete:result => {
        if (!current() || !auth.loggedIn || result?.kind !== 'authenticated' || !sameFence(result.fence, fence) ||
            ![fence.binding.accountRevision, fence.binding.accountRevision + 1].includes(result.accountRevision) ||
            !safeRevision(result.accountRevision) || result.accountRevision < 1 || auth.loginPending) throw unavailable();
        if (auth.changedAccount && result.accountRevision !== fence.binding.accountRevision + 1)
          throw Object.assign(unavailable(), {code:'INVALID_REVISION_STEP'});
        this.#binding = {...this.#binding, accountRevision:result.accountRevision};
        this.#confirmedAccountId = auth.accountId;
        this.#authenticated = true; auth.completed = true;
        return {kind:'authenticated', accountRevision:result.accountRevision};
      },
      close:() => {
        if (this.#auth === auth && this.#cli === cli) {
          if (auth.loginPending) this.#authUncertain = true;
          if (auth.mutated && !auth.completed) this.#authenticated = false;
          this.#auth = null;
        }
        auth.active = false;
      },
    };
  }
  async authenticateProvider(callback, options = {}) {
    const timeoutMs = options.timeoutMs ?? 70000;
    if (typeof callback !== 'function' || timeoutMs > 70000) throw unavailable();
    const transaction = this.beginProviderTransaction({...options, timeoutMs});
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => callback({fence:transaction.fence, request:transaction.request})),
        transaction.invalidated,
        new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), timeoutMs); }),
      ]);
      return transaction.complete(result);
    } catch {
      if (transaction.current()) this.invalidateProvider();
      throw unavailable();
    } finally { clearTimeout(timer); transaction.close(); }
  }
  useAccountGrant({leaseId, leaseRevision, accountRevision, appServerGeneration}) {
    if (!this.#authenticated || this.#auth || appServerGeneration !== this.#binding?.appServerGeneration ||
        accountRevision !== this.#binding.accountRevision || typeof leaseId !== 'string' || !leaseId ||
        !safeRevision(leaseRevision) || leaseRevision < 1) throw unavailable();
    this.#binding = {...this.#binding, leaseId, leaseRevision};
    return this.fence;
  }
  claimProviderRequest(request) {
    const id = String(request?.id);
    if (!this.#ready || this.#requests.get(id) !== request || this.#claimedRequests.has(id) ||
        request.method !== 'account/chatgptAuthTokens/refresh') return false;
    this.#claimedRequests.add(id); return true;
  }
  respondProvider(id, result, fence) {
    const request = this.#requests.get(String(id));
    if (!this.#cli || !request || !this.#claimedRequests.has(String(id)) || request.method !== 'account/chatgptAuthTokens/refresh' ||
        !sameFence(fence, this.fence) || (!this.#authenticated && !this.#auth?.active)) throw unavailable('connection_changed');
    const expectedAccount = this.#auth?.mutated ? this.#auth.accountId : this.#confirmedAccountId;
    if (!expectedAccount || result?.chatgptAccountId !== expectedAccount) throw Object.assign(unavailable(), {code:'AUTH_REVOKED'});
    this.#requests.delete(String(id)); this.#claimedRequests.delete(String(id));
    return this.#cli.respond(id, result);
  }
  refuseProvider(id, code, fence) {
    const request = this.#requests.get(String(id));
    if (!this.#cli || !request || !this.#claimedRequests.has(String(id)) || request.method !== 'account/chatgptAuthTokens/refresh' ||
        !sameFence(fence, this.fence)) throw unavailable('connection_changed');
    const numeric = {AUTH_REQUIRED:-32001, AUTH_REVOKED:-32002, PROVIDER_PROCESS_UNCERTAIN:-32003}[code] || -32000;
    this.#requests.delete(String(id)); this.#claimedRequests.delete(String(id));
    // Consume before sending. A lost error ACK never permits refresh replay.
    this.invalidateProvider();
    return this.#cli.respond(id, null, {code:numeric, message:'Provider access is unavailable. Open connection settings and reconnect.', data:{code}});
  }
  ownsProviderRequest(request, fence) {
    return this.#requests.get(String(request?.id)) === request && this.#claimedRequests.has(String(request?.id)) && sameFence(fence, this.fence);
  }
  respond(id, result, error) {
    if (!this.#cli) return false;
    // A negative reply can always release a pending request. Positive replies
    // require a confirmed binding; external refresh routing is a later v2 seam.
    if (!error && (!this.#authenticated || this.#requests.get(String(id))?.method === 'account/chatgptAuthTokens/refresh')) throw unavailable();
    this.#requests.delete(String(id));
    this.#claimedRequests.delete(String(id));
    return this.#cli.respond(id, result, error);
  }
  dispose() {
    this.invalidateProvider(); this.#requests.clear(); this.#claimedRequests.clear(); this.#confirmedAccountId = null; this.#ready = false; this.#epoch++;
    const cli = this.#cli; this.#cli = null; this.#starting = null;
    cli?.dispose();
  }
}
module.exports = {ServiceAppServer};
