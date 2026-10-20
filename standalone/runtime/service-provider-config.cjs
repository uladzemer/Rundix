const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {parseStrict} = require('./service-json.cjs');

function actionRequired(code = 'PROVIDER_CONFIG_INVALID') {
  return Object.assign(Error('Open the installed companion connection settings to restore provider access.'),
    {code, reason:'action_required', recoveryRequired:false});
}
function configLocation(options = {}) { return require('./service-paths.cjs').servicePaths(options).providerConfig; }
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function absolute(file) {
  if (typeof file !== 'string' || file.includes('\0') || !path.isAbsolute(file) ||
      (process.platform === 'win32' && /^\\\\/.test(file))) throw actionRequired();
  return file;
}
function real(file) {
  const result = fs.realpathSync.native(file);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}
function privatePath(file) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink()) throw actionRequired();
  if (process.platform !== 'win32') {
    if (info.uid !== process.getuid() || (info.mode & 0o077)) throw actionRequired();
    return;
  }
  // Read-only ACL validation, no repair or ownership changes. Encoded literals
  // keep paths out of PowerShell syntax; output contains only a fixed verdict.
  const literal = Buffer.from(file, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${literal}')); ` +
    `$a=Get-Acl -LiteralPath $p; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ` +
    `$owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; if($owner -ne $sid){exit 2}; ` +
    `$rules=$a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]); $own=$false; ` +
    `foreach($r in $rules){if($r.AccessControlType -eq 'Allow'){if($r.IdentityReference.Value -ne $sid -and $r.IdentityReference.Value -ne 'S-1-5-18'){exit 2}; if($r.IdentityReference.Value -eq $sid){$own=$true}}}; ` +
    `if(-not $own){exit 2}; 'ok'`;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {windowsHide:true, timeout:10000, maxBuffer:1024, encoding:'utf8', stdio:['ignore', 'pipe', 'pipe']});
  if (output.trim() !== 'ok') throw actionRequired();
}
function boundedRead(file, limit) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw actionRequired();
    fd = fs.openSync(file, 'r');
    const after = fs.fstatSync(fd);
    if (!after.isFile() || after.size > limit || after.dev !== before.dev || after.ino !== before.ino) throw actionRequired();
    const buffer = Buffer.alloc(limit + 1);
    let size = 0, count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null))) size += count;
    if (size > limit) throw actionRequired();
    return buffer.subarray(0, size);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function noLinks(file) {
  for (let current = file;; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw actionRequired();
    if (path.dirname(current) === current) return;
  }
}
function readProviderConfig({configPath = configLocation(), verifyPrivate = privatePath} = {}) {
  try {
    absolute(configPath); noLinks(configPath);
    verifyPrivate(path.dirname(configPath)); verifyPrivate(configPath);
    const bytes = boundedRead(configPath, 16384), config = parseStrict(bytes);
    if (!exact(config, ['schemaVersion', 'configRevision', 'manifestPath', 'provider']) || config.schemaVersion !== 1 ||
        !Number.isSafeInteger(config.configRevision) || config.configRevision < 1 ||
        !exact(config.provider, ['id', 'protocolMajor', 'version', 'entryPath', 'manifestSha256'])) throw actionRequired();
    const provider = config.provider;
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(provider.id) || provider.protocolMajor !== 2 ||
        typeof provider.version !== 'string' || !provider.version || provider.version.length > 128 ||
        typeof provider.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(provider.manifestSha256)) throw actionRequired();
    absolute(config.manifestPath); absolute(provider.entryPath);
    if (path.basename(config.manifestPath) !== 'provider-manifest.json' || path.extname(provider.entryPath) !== '.cjs') throw actionRequired();
    noLinks(config.manifestPath); noLinks(provider.entryPath);
    const directory = path.dirname(config.manifestPath);
    if (real(path.dirname(provider.entryPath)) !== real(directory)) throw actionRequired();
    for (const file of [directory, config.manifestPath, provider.entryPath]) verifyPrivate(file);
    const manifestBytes = boundedRead(config.manifestPath, 16384);
    if (digest(manifestBytes) !== provider.manifestSha256) throw actionRequired();
    const manifest = parseStrict(manifestBytes);
    if (!exact(manifest, ['schemaVersion', 'providerId', 'providerVersion', 'protocolVersion', 'entry', 'entrySha256']) ||
        manifest.schemaVersion !== 1 || manifest.providerId !== provider.id || manifest.providerVersion !== provider.version ||
        manifest.protocolVersion !== 1 || typeof manifest.entry !== 'string' || manifest.entry.includes('..') ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.cjs$/.test(manifest.entry) ||
        typeof manifest.entrySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.entrySha256) ||
        real(path.join(directory, manifest.entry)) !== real(provider.entryPath)) throw actionRequired();
    if (digest(boundedRead(provider.entryPath, 16 * 1024 * 1024)) !== manifest.entrySha256) throw actionRequired();
    return {...config, configSha256:digest(bytes), entryPath:real(provider.entryPath)};
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(configPath)) throw actionRequired('PROVIDER_NOT_CONFIGURED');
    throw actionRequired();
  }
}
function readProviderConfigAsync(options = {}) {
  if (options.verifyPrivate) return Promise.resolve().then(() => readProviderConfig(options));
  const {Worker} = require('node:worker_threads');
  return new Promise((resolve, reject) => {
    // Never serialize credentials, environment or injected functions.
    const worker = new Worker(__filename, {workerData:{providerConfig:{configPath:options.configPath || configLocation()}}});
    const timer = setTimeout(() => {worker.terminate();reject(actionRequired('PROVIDER_UNAVAILABLE'));}, 60000);
    worker.once('message', value => {clearTimeout(timer);value.error ? reject(actionRequired(value.error)) : resolve(value.result);});
    worker.once('error', () => {clearTimeout(timer);reject(actionRequired());});
    worker.once('exit', code => {if(code){clearTimeout(timer);reject(actionRequired());}});
  });
}
module.exports = {readProviderConfig, readProviderConfigAsync, configLocation, actionRequired, boundedRead, digest};
const {isMainThread, workerData, parentPort} = require('node:worker_threads');
if (!isMainThread && workerData?.providerConfig) {
  try {parentPort.postMessage({result:readProviderConfig(workerData.providerConfig)});}
  catch(error) {parentPort.postMessage({error:error.reason === 'action_required' ? error.code : 'PROVIDER_CONFIG_INVALID'});}
}
