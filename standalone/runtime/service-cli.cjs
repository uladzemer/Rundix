// Service-only safety boundary. The window transport is intentionally unchanged.
// This does not implement provider v2 admission/grants: its trusted caller must
// supply the installed-provider callback and still admit every turn separately.
const {EventEmitter} = require('node:events');
const {randomUUID} = require('node:crypto');
const {spawn} = require('node:child_process');
const {AppServer} = require('./transport.cjs');

const METHODS = new Set(['model/list', 'config/read', 'account/read',
  'account/rateLimits/read', 'thread/start', 'thread/resume', 'thread/read',
  'thread/turns/list', 'thread/items/list', 'thread/name/set', 'turn/start',
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
function environment(source) {
  // Preserve CODEX_HOME and the normal user configuration/history. Credential
  // overrides cannot choose a personal sign-in for the service process.
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^(?:OPENAI|CODEX|CHATGPT)_.*(?:AUTH|TOKEN|KEY|SECRET|PASSWORD)/i.test(key)));
}
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
      this.invalidateProvider(); this.#authUncertain = false; this.#ready = false;
      cli = new AppServer(this.#options); this.#cli = cli;
      this.#binding = {appServerId:randomUUID(), appServerGeneration:randomUUID(),
        accountRevision:0, leaseId:randomUUID(), leaseRevision:1};
      cli.on('disconnected', () => {
        if (this.#cli !== cli) return;
        this.invalidateProvider(); this.#ready = false; this.#cli = null; this.#starting = null;
        this.emit('disconnected', 'CLI disconnected. Reconnect the provider.');
      });
      cli.on('protocolError', () => { if (this.#cli === cli) this.emit('protocolError', 'CLI protocol error.'); });
      for (const event of ['notification', 'request']) cli.on(event, message => {
        if (this.#cli === cli) this.emit(event, message);
      });
      const result = await cli.start();
      if (this.#cli !== cli || this.#epoch !== epoch) throw unavailable('connection_changed');
      this.#ready = true;
      return result;
    })().catch(error => {
      if (this.#epoch === epoch) {
        this.invalidateProvider(); this.#ready = false; this.#cli = null; this.#starting = null; cli?.dispose();
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
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 90000) return Promise.reject(unavailable());
    const fence = this.fence;
    const result = await this.#request(this.#cli, method, params, timeoutMs);
    if (!sameFence(fence, this.fence)) throw Object.assign(unavailable('connection_changed'), {deliveryUncertain:true});
    return result;
  }
  async authenticateProvider(callback, {leaseId, leaseRevision, timeoutMs = 70000} = {}) {
    if (!this.#ready || !this.#cli || !this.#binding || this.#auth || this.#authUncertain || typeof callback !== 'function' ||
        typeof leaseId !== 'string' || !leaseId || !safeRevision(leaseRevision) || leaseRevision < 1 ||
        !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 70000) throw unavailable();
    this.#authenticated = false;
    this.#binding = {...this.#binding, leaseId, leaseRevision};
    const cli = this.#cli, fence = this.fence;
    const auth = {active:true, loggedIn:false, loginPending:0}; this.#auth = auth;
    let timer;
    const current = () => auth.active && this.#auth === auth && this.#cli === cli && sameFence(this.fence, fence);
    const deadline = Date.now() + timeoutMs;
    const request = async (method, params = {}, budget = 70000) => {
      if (!current()) throw unavailable('connection_changed');
      if (!PROVIDER_METHODS.has(method) || (method === 'account/login/start' && params.type !== 'chatgptAuthTokens'))
        throw Object.assign(Error('CLI method is unsupported.'), {code:'METHOD_NOT_SUPPORTED', deliveryUncertain:false});
      if (!Number.isFinite(budget) || budget <= 0 || budget > 70000) throw unavailable();
      const remaining = Math.min(budget, deadline - Date.now());
      if (remaining <= 0) throw unavailable();
      const loginRequest = method === 'account/login/start';
      if (loginRequest) auth.loginPending++;
      let result;
      try { result = await this.#request(cli, method, params, remaining); }
      catch (error) {
        if (loginRequest && error.deliveryUncertain && this.#cli === cli) this.#authUncertain = true;
        throw error;
      } finally { if (loginRequest) auth.loginPending--; }
      if (!current()) throw unavailable('connection_changed');
      if (method === 'account/login/start') {
        if (result?.type !== 'chatgptAuthTokens') throw unavailable();
        auth.loggedIn = true;
      }
      return result;
    };
    try {
      const timeout = new Promise((_, reject) => {
        auth.abort = () => reject(unavailable('connection_changed'));
        timer = setTimeout(() => {
          if (auth.loginPending && this.#cli === cli) this.#authUncertain = true;
          auth.active = false; reject(unavailable());
        }, timeoutMs);
      });
      // Defer the callback so synchronous failures take the same cleanup path.
      const result = await Promise.race([Promise.resolve().then(() => callback({fence:structuredClone(fence), request})), timeout]);
      if (!current() || !auth.loggedIn || result?.kind !== 'authenticated' || !sameFence(result.fence, fence) ||
          ![fence.binding.accountRevision, fence.binding.accountRevision + 1].includes(result.accountRevision) ||
          !safeRevision(result.accountRevision) || result.accountRevision < 1 || auth.loginPending) throw unavailable();
      this.#binding = {...this.#binding, accountRevision:result.accountRevision};
      this.#authenticated = true;
      return {kind:'authenticated', accountRevision:result.accountRevision};
    } catch {
      if (this.#auth === auth && this.#cli === cli) this.#authenticated = false;
      throw unavailable();
    } finally {
      if (auth.loginPending && this.#cli === cli) this.#authUncertain = true;
      clearTimeout(timer); auth.active = false;
      if (this.#auth === auth) this.#auth = null;
    }
  }
  respond(id, result, error) {
    if (!this.#cli) return false;
    // A negative reply can always release a pending request. Positive replies
    // require a confirmed binding; external refresh routing is a later v2 seam.
    if (!error && !this.#authenticated) throw unavailable();
    return this.#cli.respond(id, result, error);
  }
  dispose() {
    this.invalidateProvider(); this.#ready = false; this.#epoch++;
    const cli = this.#cli; this.#cli = null; this.#starting = null;
    cli?.dispose();
  }
}
module.exports = {ServiceAppServer};
