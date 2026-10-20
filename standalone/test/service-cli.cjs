require('./test-isolation.cjs').isolate();
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {once} = require('node:events');
const {ServiceAppServer} = require('../runtime/service-cli.cjs');

const authority = {serviceGeneration:'synthetic-service', providerGeneration:'synthetic-provider', configRevision:1};
const grant = {leaseId:'synthetic-idle-grant', leaseRevision:1};
const login = {type:'chatgptAuthTokens', chatgptAccountId:'synthetic-account', accessToken:'SYNTHETIC_NOT_A_CREDENTIAL'};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-service-cli-synthetic-'));
  const home = path.join(root, 'normal-home'); fs.mkdirSync(home);
  const sourceEnv = {...process.env, CODEX_HOME:home, OPENAI_API_KEY:'SYNTHETIC_NOT_A_KEY',
    codex_api_key:'SYNTHETIC_NOT_A_KEY', CODEX_AUTH_JSON:'SYNTHETIC_NOT_AUTH', CHATGPT_ACCESS_TOKEN:'SYNTHETIC_NOT_A_TOKEN'};
  const starts = [], children = [];
  const options = {authority, executable:process.execPath, cwd:root, env:sourceEnv,
    configArgs:['-c', 'features.default_mode_request_user_input=true'],
    spawnProcess(executable, argv, opts) {
      assert.equal(executable, process.execPath); starts.push({argv, opts});
      const child = spawn(process.execPath, [path.join(__dirname, 'fake-service-cli.cjs')], opts);
      const done = once(child, 'close'); children.push({child, done}); return child;
    }};
  const cli = new ServiceAppServer(options);
  const authenticate = async (account = 'synthetic-account', transform = value => value, authOptions = {}) =>
    cli.authenticateProvider(async ({fence, request}) => {
      await request('account/login/start', {...login, chatgptAccountId:account});
      return transform({kind:'authenticated', accountRevision:fence.binding.accountRevision + 1, fence});
    }, {...grant, ...authOptions});
  const gated = async () => {
    for (const method of ['turn/start', 'turn/steer', 'thread/compact/start'])
      await assert.rejects(cli.request(method, {threadId:'synthetic-thread'}), {code:'connection_unavailable', reason:'action_required'});
  };
  try {
    await gated();
    assert.equal(cli.write, undefined); assert.equal(cli.child, undefined, 'No public raw CLI bypass');
    await Promise.all([cli.start(), cli.start()]); assert.equal(starts.length, 1);
    assert.throws(() => cli.respond('synthetic-request', {}), {code:'connection_unavailable'});
    const initialGeneration = cli.binding.appServerGeneration;
    const config = await cli.request('config/read'); assert.equal(config.codexHome, home);
    await cli.request('account/read'); await gated(); // personal account/read never opens gate
    const {argv, opts} = starts[0];
    assert.deepEqual(argv, ['app-server', '--listen', 'stdio://', '-c', 'features.default_mode_request_user_input=true',
      '-c', 'cli_auth_credentials_store="ephemeral"']);
    assert.equal(opts.shell, false); assert.equal(opts.windowsHide, true);
    assert.equal(opts.env.CODEX_HOME, home);
    for (const name of ['OPENAI_API_KEY', 'codex_api_key', 'CODEX_AUTH_JSON', 'CHATGPT_ACCESS_TOKEN']) assert(!Object.hasOwn(opts.env, name));
    assert.equal(sourceEnv.OPENAI_API_KEY, 'SYNTHETIC_NOT_A_KEY', 'Parent environment unchanged');
    for (const method of ['account/logout', 'account/login/start', 'config/value/write', 'config/batchWrite', 'unknown'])
      await assert.rejects(cli.request(method), {code:'METHOD_NOT_SUPPORTED'});
    await assert.rejects(cli.request('config/read', {}, Infinity), {code:'connection_unavailable'});
    assert.throws(() => new ServiceAppServer({...options, configArgs:['-c', 'cli_auth_credentials_store="file"']}), {code:'connection_unavailable'});

    // Both successful external CLI login and a current fenced provider outcome
    // are required. No persistence or raw tokens in any observation.
    for (const callback of [
      async ({fence}) => ({kind:'authenticated', accountRevision:1, fence}), // no login
      async ({request}) => request('account/login/start', {...login, type:'chatgpt'}),
      async ({request}) => request('account/logout'),
      async ({request}) => request('turn/start'),
    ]) {
      await assert.rejects(cli.authenticateProvider(callback, grant), {code:'connection_unavailable'}); await gated();
    }
    for (const account of ['synthetic-reject', 'synthetic-wrong-type']) {
      const error = await authenticate(account).catch(error => error);
      assert.equal(error.code, 'connection_unavailable'); assert(!error.message.includes('private diagnostic')); await gated();
    }
    for (const change of [
      result => ({...result, kind:'ready'}),
      result => ({...result, accountRevision:2}),
      result => ({...result, fence:{...result.fence, providerGeneration:'stale'}}),
      result => ({...result, fence:{...result.fence, configRevision:0}}),
      result => ({...result, fence:{...result.fence, serviceGeneration:'stale'}}),
      result => ({...result, fence:{...result.fence, binding:{...result.fence.binding, appServerGeneration:'stale'}}}),
      result => ({...result, fence:{...result.fence, binding:{...result.fence.binding, leaseId:'stale'}}}),
      result => ({...result, fence:{...result.fence, binding:{...result.fence.binding, leaseRevision:0}}}),
    ]) {
      await assert.rejects(authenticate('synthetic-account', change), {code:'connection_unavailable'}); await gated();
    }
    await authenticate(); assert.equal(cli.authenticated, true); assert.equal(cli.binding.accountRevision, 1);
    assert.equal((await cli.request('turn/start', {threadId:'synthetic-thread'})).turn.id, 'synthetic-turn');
    cli.invalidateProvider(); await gated();
    await authenticate(); assert.equal(cli.binding.accountRevision, 2);
    await authenticate('synthetic-account', result => ({...result, accountRevision:2}));
    assert.equal(cli.binding.accountRevision, 2, 'Repeat login in current epoch may echo current revision');
    cli.invalidateProvider();
    let lateRequest;
    await assert.rejects(cli.authenticateProvider(async ({request}) => {lateRequest = request; await delay(50); return {};}, {...grant, timeoutMs:10}), {code:'connection_unavailable'});
    await assert.rejects(lateRequest('account/login/start', login), {code:'connection_unavailable'}); await gated();
    // A timed-out callback/result can never authorize a later generation.
    await assert.rejects(authenticate('synthetic-delay', value => value, {timeoutMs:10}), {code:'connection_unavailable'});
    await delay(100); await gated();
    await assert.rejects(authenticate(), {code:'connection_unavailable'}, 'Uncertain old login requires a fresh process');
    cli.dispose(); await cli.start();

    const pending = authenticate('synthetic-delay').then(() => null, error => error);
    await delay(10); cli.invalidateProvider();
    await assert.rejects(authenticate(), {code:'connection_unavailable'}, 'Do not race another login against an outstanding old mutation');
    cli.dispose(); await cli.start(); await authenticate(); await pending;
    assert.equal(cli.authenticated, true, 'Old auth failure must not close a new successful gate');
    const before = await cli.request('config/read');
    assert(!before.methods.includes('account/logout')); assert(!before.methods.includes('config/value/write'));
    const disconnected = once(cli, 'disconnected'); children.at(-1).child.kill(); await disconnected;
    await gated(); await cli.start();
    assert.notEqual(cli.binding.appServerGeneration, initialGeneration); assert.equal(cli.binding.accountRevision, 0);
    await gated(); await authenticate();
    const restarted = await cli.request('config/read'); assert(!restarted.methods.includes('turn/start'));

    // Disposal/restart fences a callback whose CLI login has not settled yet.
    cli.invalidateProvider(); const stale = authenticate('synthetic-delay').then(() => null, error => error);
    await delay(10); cli.dispose(); await cli.start(); await authenticate(); await stale;
    assert.equal(cli.authenticated, true); cli.dispose(); await cli.start(); await gated();
    assert.equal(cli.binding.accountRevision, 0);
    // A successful kill request alone does not prove process death. Refuse a
    // replacement if close never arrives, then recover only after actual exit.
    const old = children.at(-1), originalKill = old.child.kill.bind(old.child);
    old.child.kill = () => true;
    try {
      cli.dispose(); const count = starts.length;
      await assert.rejects(cli.start(), {code:'recovery_required'});
      assert.equal(starts.length, count); await gated();
    } finally { old.child.kill = originalKill; originalKill(); await old.done; }
    await cli.start(); await gated(); await authenticate();
    const unknownTurn = cli.request('turn/start', {threadId:'synthetic-delay'}).then(() => null, error => error);
    await delay(10); cli.dispose();
    const unknown = await unknownTurn;
    assert.equal(unknown.deliveryUncertain, true, 'A dispatched turn is never safe to replay on generation loss');
    assert.equal(unknown.reason, 'connection_changed');
    await cli.start(); await gated();
    console.log('PASS service CLI: ephemeral argv, normal home, sanitized env, no logout/config mutation, external-login proof, fenced auth, timeout/loss/restart gates.');
  } finally {
    cli.dispose();
    for (const {child} of children) child.kill();
    await Promise.all(children.map(value => value.done));
    assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith('rundix-service-cli-synthetic-'));
    fs.rmSync(root, {recursive:true, force:true});
  }
}
main().catch(() => { console.error('FAIL synthetic service CLI safety checks'); process.exitCode = 1; });
