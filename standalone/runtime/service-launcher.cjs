// Trusted installation only. Workspace input never selects an executable.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {locations, protectDirectory} = require('./service-endpoint.cjs');
const {parseStrict} = require('./service-json.cjs');

function atomic(file, text) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, text, {flag:'wx', mode:0o600}); fs.renameSync(temp, file); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
function registration(root) {
  try {
    const file = path.join(root, 'installation.json'), info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384 ||
        (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw Error();
    const value = parseStrict(fs.readFileSync(file));
    if (value.schemaVersion !== 1 || !['nodePath','entryPath','adapterPath'].every(key =>
      typeof value[key] === 'string' && path.isAbsolute(value[key]) && fs.statSync(value[key]).isFile())) throw Error();
    for (const key of ['entryPath','adapterPath']) {
      const relative = path.relative(fs.realpathSync(path.join(root, 'versions')), fs.realpathSync(value[key]));
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error();
    }
    return value;
  } catch { throw Object.assign(Error('Install the service launcher from Rundix first.'), {code:'service_install_required'}); }
}
function installLauncher({source = path.join(__dirname, '..'), nodePath = process.execPath, root} = {}) {
  root = locations({root}).directory;
  protectDirectory(root);
  const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
  // Keep running versions intact. The registration switches only after a complete copy.
  const target = path.join(root, 'versions', version + '-' + randomUUID());
  fs.mkdirSync(target, {recursive:true, mode:0o700});
  for (const dir of ['runtime','ui']) {
    fs.mkdirSync(path.join(target, dir), {mode:0o700});
    for (const file of fs.readdirSync(path.join(source, dir))) {
      if (!(dir === 'runtime' ? /\.cjs$/.test(file) || file === 'cli-manifest.json' : /\.js$/.test(file))) continue;
      fs.copyFileSync(path.join(source, dir, file), path.join(target, dir, file));
    }
  }
  fs.copyFileSync(path.join(source, 'package.json'), path.join(target, 'package.json'));
  const value = {schemaVersion:1, version, nodePath,
    entryPath:path.join(target, 'runtime', 'service-main.cjs'), adapterPath:path.join(target, 'runtime', 'service-adapter.cjs')};
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin, {recursive:true, mode:0o700});
  const launcher = path.join(bin, 'mcp-server.cjs');
  // Paths derive from this stable shim, preserving the caller's cwd and environment.
  atomic(launcher, "const fs=require('node:fs'),path=require('node:path');\nconst root=path.resolve(__dirname,'..');\ntry{const r=JSON.parse(fs.readFileSync(path.join(root,'installation.json'),'utf8'));require(r.adapterPath).main({root});}catch{process.stderr.write('service_install_required\\n');process.exitCode=1;}\n");
  atomic(path.join(root, 'installation.json'), JSON.stringify(value));
  return {launcher, configuration:{mcpServers:{rundix:{command:nodePath, args:[launcher, '--service'], env:{ELECTRON_RUN_AS_NODE:'1'}}}}};
}
module.exports = {installLauncher, registration};
