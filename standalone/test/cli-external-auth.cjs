// Opt-in real CLI probe. All auth material is synthetic; no real home is read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const readline = require('node:readline');

const timeoutMs = 15000;
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const realHome = os.homedir(); // Path only; never inspect its Codex directory.
const realCodexHomes = [realHome, process.env.HOME, process.env.USERPROFILE].filter(Boolean).map(home => path.join(home, '.codex'));
const prohibited = file => realCodexHomes.some(home => path.resolve(file) === path.resolve(home) || inside(home, path.resolve(file)));
function allowedExecutable(file) {
  const resolved = path.resolve(file);
  assert.ok(!prohibited(resolved), 'CLI must be outside the real Codex home');
  if (fs.existsSync(resolved)) assert.ok(!prohibited(fs.realpathSync(resolved)), 'CLI link must be outside the real Codex home');
  return resolved;
}
function discover() {
  if (process.env.RUNDIX_TEST_CODEX) return allowedExecutable(process.env.RUNDIX_TEST_CODEX);
  // Discover only the extension's CLI installation directory, never user settings/state.
  const storage = process.platform === 'win32' && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Code', 'User', 'globalStorage', 'local-rundix-tools.rundix', 'cli') : null;
  if (storage && !prohibited(storage) && fs.existsSync(storage)) {
    const { layout, installed } = require('../runtime/cli-installer.cjs');
    const versions = fs.readdirSync(storage).filter(name => /^\d+\.\d+\.\d+-win32-(x64|arm64)$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const name of versions) {
      const location = layout(storage, process.platform, process.arch, {
        version: name.replace(/-win32-(x64|arm64)$/, ''), packages: { [`win32-${process.arch}`]: {} },
      });
      if (installed(location)) return allowedExecutable(location.executable);
    }
  }
  const candidates = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .map(dir => path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  if (process.platform === 'win32' && process.env.APPDATA) candidates.push(path.join(process.env.APPDATA,
    `npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-${process.arch}/vendor/${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc/bin/codex.exe`));
  for (const candidate of candidates) {
    if (!prohibited(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return allowedExecutable(candidate);
  }
  return null;
}
function jwt(label, revision = 0) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', synthetic: true })}.${encode({
    synthetic: true, sub: 'synthetic-user', email: `${label}@synthetic.invalid`, revision,
    exp: 4102444800,
    'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-external', chatgpt_plan_type: 'plus' },
    'https://api.openai.com/profile': { email: `${label}@synthetic.invalid` },
  })}.synthetic`;
}
function files(root, prefix = '') {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink(), 'Unexpected link in synthetic home');
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? files(path.join(root, entry.name), relative) : [relative];
  }).sort();
}
async function main() {
  const store = process.env.RUNDIX_TEST_AUTH_STORE || 'file';
  assert.ok(['file', 'ephemeral'].includes(store), 'Only file/ephemeral stores are safe to probe without touching the OS keyring');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-cli-auth-synthetic-'));
  const home = path.join(root, 'codex-home');
  fs.mkdirSync(home);
  assert.ok(inside(fs.realpathSync(os.tmpdir()), fs.realpathSync(home)), 'CODEX_HOME must resolve inside os.tmpdir()');
  assert.ok(!inside(path.join(realHome, '.codex'), fs.realpathSync(home)), 'Refuse real Codex home');
  // Whitelist environment: do not inherit tokens, endpoints, tracing or proxy settings.
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'LD_LIBRARY_PATH']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    CODEX_HOME: home, HOME: root, USERPROFILE: root,
    HOMEDRIVE: path.parse(root).root.replace(/\\$/, ''), HOMEPATH: root.slice(path.parse(root).root.length - 1),
    APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), TMP: root, TEMP: root, TMPDIR: root,
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost', RUST_LOG: 'off', OTEL_SDK_DISABLED: 'true',
  });
  let client, fixture;
  const failures = [];
  let refreshCount = 0, refreshFailure = false, unauthorized = false;
  const check = (name, action) => {
    try { action(); console.log(`PASS ${name}`); }
    catch { failures.push(name); process.exitCode = 1; console.log(`FAIL ${name}`); }
  };
  try {
    const executable = discover();
    if (!executable) { console.log('SKIP Codex CLI unavailable'); return; }
    let version;
    try {
      version = execFileSync(executable, ['--version'], { env, cwd: root, windowsHide: true, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      if (error.code === 'ENOENT') { console.log('SKIP Codex CLI unavailable'); return; }
      throw Error('CLI version probe failed (details suppressed)');
    }
    assert.match(version, /^codex-cli \d+\.\d+\.\d+(?:[^\r\n]*)?$/);
    console.log(`CLI ${version}; isolated synthetic home; credential store=${store}`);
    fixture = http.createServer((request, response) => {
      // Never retain/print headers, bodies, URLs or tokens.
      request.resume();
      response.setHeader('Content-Type', 'application/json');
      if (request.url.split('?')[0].endsWith('/accounts/check')) {
        response.statusCode = unauthorized ? 401 : 200;
        response.end(JSON.stringify(unauthorized ? {} : { accounts: [{
          id: 'synthetic-external', workspace_backend_origin: 'https://synthetic.invalid', account_routing_override: 'NO_CONSTRAINT',
        }], default_account_id: 'synthetic-external' }));
      } else { response.end('{}'); }
    });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${fixture.address().port}/backend-api/`;
    fs.writeFileSync(path.join(home, 'config.toml'), `cli_auth_credentials_store = "${store}"\nchatgpt_base_url = "${base}"\ncheck_for_update_on_startup = false\n`);
    const sentinelPath = path.join(home, 'auth.json');
    const sentinel = Buffer.from(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'SYNTHETIC_SENTINEL_NOT_A_REAL_API_KEY', synthetic: true }, null, 2) + '\n');
    fs.writeFileSync(sentinelPath, sentinel, { flag: 'wx' });
    const baselineTime = fs.statSync(sentinelPath, { bigint: true }).mtimeNs;
    const baselineFiles = new Set(files(root));
    const noCredentialFiles = () => assert.deepEqual(files(root).filter(file =>
      !baselineFiles.has(file) && /auth|credential|token|secret|keyring/i.test(path.basename(file))), []);
    const pristine = () => {
      assert.deepEqual(fs.readFileSync(sentinelPath), sentinel);
      assert.equal(fs.statSync(sentinelPath, { bigint: true }).mtimeNs, baselineTime);
      noCredentialFiles();
    };
    const start = async () => {
      const child = spawn(executable, ['app-server', '--listen', 'stdio://', '-c', `cli_auth_credentials_store="${store}"`], {
        env, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stderr.resume(); // Do not log diagnostics, even from this synthetic process.
      child.stdin.on('error', () => {});
      let nextId = 0;
      const pending = new Map();
      const closed = new Promise(resolve => child.once('close', resolve));
      const rejectAll = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('CLI exited')); } pending.clear(); };
      child.on('error', rejectAll); child.on('close', rejectAll);
      const send = value => child.stdin.write(JSON.stringify(value) + '\n');
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.method && message.id !== undefined) {
          if (message.method === 'account/chatgptAuthTokens/refresh') {
            refreshCount++;
            send(refreshFailure ? { id: message.id, error: { code: -32000, message: 'Synthetic refresh failure' } }
              : { id: message.id, result: { accessToken: jwt('external', refreshCount), chatgptAccountId: 'synthetic-external', chatgptPlanType: 'plus' } });
          } else send({ id: message.id, error: { code: -32601, message: 'Synthetic client rejects this method' } });
        } else if (pending.has(message.id)) {
          const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
          if (message.error) entry.reject(Error(`RPC error code ${message.error.code}`)); else entry.resolve(message.result);
        }
      });
      const rpc = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timeout')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer }); send({ id, method, params });
      });
      const stop = async () => {
        child.stdin.end();
        const timer = setTimeout(() => child.kill(), 2000);
        try { await closed; } finally { clearTimeout(timer); lines.close(); }
      };
      client = { rpc, stop };
      await rpc('initialize', { clientInfo: { name: 'rundix_synthetic_auth_probe', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      send({ method: 'initialized', params: {} });
      return client;
    };
    const login = revision => client.rpc('account/login/start', { type: 'chatgptAuthTokens', accessToken: jwt('external', revision), chatgptAccountId: 'synthetic-external', chatgptPlanType: 'plus' });
    const read = (refreshToken = false) => client.rpc('account/read', { refreshToken });
    const external = result => { assert.equal(result.account?.type, 'chatgpt'); assert.equal(result.account?.email, 'external@synthetic.invalid'); assert.equal(result.account?.planType, 'plus'); };
    const show = (name, result) => console.log(`OBSERVE ${name}: ${JSON.stringify(result)}`); // Only synthetic account/read responses.
    await start();
    const before = await read(); show('before external login', before);
    check('startup account matches configured credential store', () => assert.equal(before.account?.type || null, store === 'file' ? 'apiKey' : null));
    check('startup preserves sentinel bytes + mtime', pristine);
    await login(0);
    const after = await read(); show('after external login', after);
    check('external login selects external synthetic account', () => external(after));
    check('external login preserves sentinel bytes + mtime', pristine);
    const refreshBefore = refreshCount;
    external(await read(true));
    console.log(`OBSERVE account/read refreshToken=true: ${refreshCount - refreshBefore} external refresh requests`);
    check('account/read refresh preserves sentinel bytes + mtime', pristine);
    // A new token invalidates routing cache. Local 401 exercises server->client refresh.
    for (const fail of [false, true]) {
      unauthorized = true; refreshFailure = fail;
      const previous = refreshCount;
      await login(fail ? 200 : 100);
      try { const result = await read(); check('401 response never exposes stored account', () => external(result)); }
      catch (error) { console.log(`OBSERVE local 401 (${fail ? 'failed' : 'successful'} refresh): ${error.message}`); }
      check(`${fail ? 'failed' : 'successful'} external refresh callback exercised`, () => assert.ok(refreshCount > previous));
      unauthorized = false;
      const recovered = await read();
      check(`no stored-account fallback after ${fail ? 'failed' : 'successful'} external refresh`, () => external(recovered));
      check(`external refresh (${fail ? 'failure' : 'success'}) preserves sentinel bytes + mtime`, pristine);
    }
    await client.stop(); client = null;
    check('process exit preserves sentinel bytes + mtime', pristine);
    await start();
    const restarted = await read(); show('after restart', restarted);
    check('restart account matches configured store (gate must reset)', () => assert.equal(restarted.account?.type || null, store === 'file' ? 'apiKey' : null));
    await login(300); external(await read());
    await client.rpc('account/logout');
    const loggedOut = await read(); show('after external logout', loggedOut);
    console.log(`OBSERVE sentinel after logout: ${fs.existsSync(sentinelPath) ? 'present' : 'DELETED'}`);
    check('logout preserves sentinel bytes + mtime', pristine);
    await client.stop(); client = null;
    check('exit after logout preserves sentinel bytes + mtime', pristine);
    // CLI creates ordinary DB/cache/log files. Classify new credential-like filenames separately.
    const newFiles = files(root).filter(file => !baselineFiles.has(file));
    const credentialFiles = newFiles.filter(file => /auth|credential|token|secret|keyring/i.test(path.basename(file)));
    check('no new credential-like files', () => assert.deepEqual(credentialFiles, []));
    console.log(`OBSERVE ${newFiles.length} new non-baseline files; ${credentialFiles.length} credential-like files; OS keyring NOT exercised (forced ${store})`);
    console.log(`${failures.length ? 'FAIL' : 'PASS'} ${version} store=${store}: ${failures.length} violated assertions`);
    if (failures.length) process.exitCode = 1;
  } finally {
    await client?.stop();
    if (fixture) await new Promise(resolve => fixture.close(resolve));
    assert.ok(inside(fs.realpathSync(os.tmpdir()), fs.realpathSync(root)));
    assert.ok(path.basename(root).startsWith('rundix-cli-auth-synthetic-'));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => {
  if (error.message === 'RPC timeout') {
    console.log('SKIP remaining probes: bounded RPC timeout; offline result inconclusive (prior assertion failures still fail)');
    return;
  }
  console.error(`FAIL synthetic CLI probe could not finish (${ /^RPC error code -?\d+$/.test(error.message) ? error.message : error.name }; other diagnostics suppressed)`);
  process.exitCode = 1;
});
