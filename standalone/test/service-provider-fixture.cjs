const fs = require('node:fs'), path = require('node:path');
const {digest} = require('../runtime/service-provider-config.cjs');
function install(root) {
  const directory = path.join(root, 'installed', 'synthetic-provider', '1.0.0');
  const configPath = path.join(root, 'config', 'rundix-service', 'provider.json');
  fs.mkdirSync(directory, {recursive:true, mode:0o700}); fs.mkdirSync(path.dirname(configPath), {recursive:true, mode:0o700});
  for (const module of ['service-json', 'service-provider-rpc', 'service-provider-contract'])
    fs.copyFileSync(path.join(__dirname, '..', 'runtime', module + '.cjs'), path.join(directory, module + '.cjs'));
  const entryPath = path.join(directory, 'provider-entry.cjs');
  fs.copyFileSync(path.join(__dirname, 'fake-service-provider.cjs'), entryPath);
  const manifestPath = path.join(directory, 'provider-manifest.json');
  const manifest = {schemaVersion:1, providerId:'synthetic-provider', providerVersion:'1.0.0', protocolVersion:1,
    entry:'provider-entry.cjs', entrySha256:digest(fs.readFileSync(entryPath))};
  const manifestBytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(manifestPath, manifestBytes, {mode:0o600});
  const config = {schemaVersion:1, configRevision:1, manifestPath, provider:{id:'synthetic-provider', protocolMajor:2,
    version:'1.0.0', entryPath, manifestSha256:digest(manifestBytes)}};
  fs.writeFileSync(configPath, JSON.stringify(config), {mode:0o600});
  if (process.platform !== 'win32') for (const file of fs.readdirSync(directory)) fs.chmodSync(path.join(directory, file), 0o600);
  return {directory, configPath, config, manifestPath, manifest, entryPath};
}
module.exports = {install};
