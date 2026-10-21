require('./test-isolation.cjs').isolate();
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {parseStrict} = require('../runtime/service-json.cjs');
const {readProviderConfig, configLocation, digest} = require('../runtime/service-provider-config.cjs');
const {install} = require('./service-provider-fixture.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-provider-config-synthetic-'));
try {
  const fixture = install(root), {configPath, manifestPath, entryPath, directory, config, manifest} = fixture;
  const read = () => readProviderConfig({configPath, verifyPrivate:() => {}});
  assert.equal(read().entryPath, process.platform === 'win32' ? fs.realpathSync.native(entryPath).toLowerCase() : fs.realpathSync.native(entryPath));
  const writeConfig = value => fs.writeFileSync(configPath, JSON.stringify(value));
  const invalidConfig = value => { writeConfig(value); assert.throws(read, {code:'PROVIDER_CONFIG_INVALID', reason:'action_required'}); writeConfig(config); };
  for (const value of [{...config, extra:true}, {...config, configRevision:Number.MAX_SAFE_INTEGER + 1},
    {...config, provider:{...config.provider, protocolMajor:1}}, {...config, provider:{...config.provider, entryPath:'relative.cjs'}},
    {...config, provider:{...config.provider, manifestSha256:'0'.repeat(64)}}]) invalidConfig(value);
  for (const text of [JSON.stringify(config).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    '{"a":1,"\\u0061":2}', '[]', 'x'.repeat(16385), Buffer.from([0xff])]) {
    fs.writeFileSync(configPath, text); assert.throws(read, {code:'PROVIDER_CONFIG_INVALID'});
  }
  writeConfig(config);
  const originalEntry = fs.readFileSync(entryPath); fs.appendFileSync(entryPath, '\n// synthetic corruption');
  assert.throws(read, {code:'PROVIDER_CONFIG_INVALID'}); fs.writeFileSync(entryPath, originalEntry);
  const testManifest = value => {
    const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(manifestPath, bytes);
    writeConfig({...config, provider:{...config.provider, manifestSha256:digest(bytes)}});
    assert.throws(read, {code:'PROVIDER_CONFIG_INVALID'});
  };
  for (const value of [{...manifest, extra:true}, {...manifest, protocolVersion:2}, {...manifest, providerId:'different'},
    {...manifest, providerVersion:'different'}, {...manifest, entry:'../provider-entry.cjs'}, {...manifest, entry:'sub/entry.cjs'},
    {...manifest, entrySha256:'f'.repeat(64)}]) testManifest(value);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest)); writeConfig(config);
  const outside = path.join(root, 'outside.cjs'); fs.writeFileSync(outside, originalEntry);
  fs.unlinkSync(entryPath);
  // Junctions cannot name a file; symlink support on Windows may require a
  // privilege. Always cover directory junction escape on Windows.
  if (process.platform !== 'win32') {
    fs.symlinkSync(outside, entryPath); assert.throws(read, {code:'PROVIDER_CONFIG_INVALID'}); fs.unlinkSync(entryPath);
  }
  fs.writeFileSync(entryPath, originalEntry, {mode:0o600});
  const alias = path.join(root, 'alias'); fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  invalidConfig({...config, manifestPath:path.join(alias, 'provider-manifest.json')});
  const expected = configLocation({pathEnv:{},platform:'win32', appData:path.join(root, 'roaming'), localAppData:path.join(root, 'local'), home:root});
  assert.equal(expected, path.join(root, 'roaming', 'Rundix', 'rundix-service', 'provider.json'));
  assert.equal(configLocation({pathEnv:{},platform:'darwin', home:root}), path.join(root, 'Library', 'Application Support', 'Rundix', 'rundix-service', 'provider.json'));
  assert.throws(() => readProviderConfig({configPath:path.join(root, 'absent.json')}), {code:'PROVIDER_NOT_CONFIGURED', reason:'action_required'});
  for (const bad of ['{"a":1,"a":2}', '{"a":{"x":1,"x":2}}', '[1,]', '{"a":1,}', '1e999', '{"a":1}x', '"\\x"', Buffer.from([0xff])])
    assert.throws(() => parseStrict(Buffer.from(bad)));
  assert.equal(parseStrict(Buffer.from('{"__proto__":3,"a":[true,null,"escaped\\\""]}')).__proto__, 3);

  // A real private-path roundtrip; production does not accept unprotected files.
  if (process.platform === 'win32') {
    require('../runtime/mcp-bridge.cjs').privateDirectory(path.dirname(configPath));
    require('../runtime/mcp-bridge.cjs').privateDirectory(directory);
  }
  assert.equal(readProviderConfig({configPath}).provider.id, 'synthetic-provider');
  if (process.platform !== 'win32') {
    fs.chmodSync(configPath, 0o644); assert.throws(() => readProviderConfig({configPath}), {code:'PROVIDER_CONFIG_INVALID'});
  }
  console.log('PASS provider config: exact schema, duplicate JSON, paths/permissions, manifest and entry digests, symlink escape and missing-provider action_required.');
} finally {
  assert.equal(path.dirname(root), os.tmpdir()); assert(path.basename(root).startsWith('rundix-provider-config-synthetic-'));
  fs.rmSync(root, {recursive:true, force:true});
}
