// Trusted installation only. Workspace input never selects an executable.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID,createHash} = require('node:crypto');
const {locations, protectDirectory, readDiscovery} = require('./service-endpoint.cjs');
const {parseStrict} = require('./service-json.cjs');
const {SessionStore}=require('./store.cjs');

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
const copyName = /^[0-9][\w.-]+$/;
const retentionMs = 14 * 24 * 60 * 60 * 1000;
const incompleteGraceMs = 60 * 60 * 1000;

function copyForEntry(versions, entryPath) {
  if (typeof entryPath !== 'string' || !path.isAbsolute(entryPath)) throw Error();
  const relative = path.relative(versions, entryPath);
  const [name, ...rest] = relative.split(path.sep);
  if (!copyName.test(name) || !rest.length || path.isAbsolute(relative)) throw Error();
  const copy = path.join(versions, name);
  if (!fs.lstatSync(copy).isDirectory() ||
      path.relative(path.join(fs.realpathSync(versions), relative), fs.realpathSync(entryPath)) ||
      !fs.lstatSync(entryPath).isFile()) throw Error();
  return copy;
}

function refreshCopy(copy, now) {
  const info = fs.lstatSync(copy);
  if (!info.isDirectory() || !Number.isFinite(info.mtimeMs)) throw Error();
  if (info.mtimeMs < now) fs.utimesSync(copy, info.atime, now / 1000);
}

function refreshTargets(root, versions, target, now) {
  if (!Number.isFinite(now) || now <= 0 || !fs.lstatSync(versions).isDirectory()) return false;
  let previousRefreshed = true;
  try {
    if (fs.lstatSync(path.join(root, 'installation.json'), {throwIfNoEntry:false})) {
      // An adapter may have started just before this registration is replaced.
      const previous = copyForEntry(versions, registration(root).entryPath);
      if (path.relative(target, previous)) refreshCopy(previous, now);
    }
  } catch { previousRefreshed = false; }
  refreshCopy(target, now);
  return previousRefreshed;
}

// Both the installation and service-startup leases are held here.
function pruneCopies(where, versions, target, now) {
  if (!fs.lstatSync(versions).isDirectory()) return;
  let running;
  if (fs.lstatSync(where.descriptor, {throwIfNoEntry:false})) {
    // A present descriptor that cannot identify its copy makes pruning unsafe.
    running = copyForEntry(versions, readDiscovery(where)?.entryPath);
  }
  const entries = [];
  for (const name of fs.readdirSync(versions)) {
    if (!copyName.test(name)) continue;
    const file = path.join(versions, name);
    if (!path.relative(target, file)) continue;
    const info = fs.lstatSync(file);
    if (info.isDirectory() && Number.isFinite(info.mtimeMs) && info.mtimeMs > 0) {
      const marker = path.join(file, 'complete.json');
      const complete = fs.lstatSync(marker, {throwIfNoEntry:false})?.isFile();
      entries.push({file, marker, complete, mtime:info.mtimeMs});
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  let completeCopies = 0;
  for (const {file, marker, complete, mtime} of entries) {
    if (complete && completeCopies++ < 2) continue;
    if (mtime >= now - (complete ? retentionMs : incompleteGraceMs) ||
        (running && !path.relative(running, file))) continue;
    // A later installation must rebuild a copy left behind by partial removal.
    try { fs.unlinkSync(marker); } catch (error) { if (error.code !== 'ENOENT') continue; }
    try { fs.rmSync(file, {recursive:true, force:true}); } catch {}
  }
}

function installLauncher({source = path.join(__dirname, '..'), nodePath = process.execPath, root,legacyRoot, now} = {}) {
  const where = locations({root});
  root = where.directory;
  protectDirectory(root);
  if(legacyRoot)require('./service-migration.cjs').registerRoot(root,legacyRoot);
  const store=new SessionStore(root),until=Date.now()+10000;let unlock;
  while(!unlock){try{unlock=store.acquire('service-install');}catch(error){if(Date.now()>=until)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}
  try {
  const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
  // Keep running versions intact. The registration switches only after a complete copy.
  const files=['package.json',...['runtime','ui'].flatMap(dir=>fs.readdirSync(path.join(source,dir)).filter(file=>dir==='runtime'?/\.cjs$/.test(file)||file==='cli-manifest.json':/\.js$/.test(file)).sort().map(file=>dir+'/'+file))];
  const hash=createHash('sha256');for(const file of files)hash.update(file+'\0').update(fs.readFileSync(path.join(source,file)));
  const versions = path.join(root, 'versions');
  const target = path.join(versions, version + '-' + hash.digest('hex').slice(0,24));
  if(!fs.existsSync(path.join(target,'complete.json'))) {
  fs.mkdirSync(target, {recursive:true, mode:0o700});
  for (const dir of ['runtime','ui']) {
    fs.mkdirSync(path.join(target, dir), {recursive:true,mode:0o700});
    for (const file of fs.readdirSync(path.join(source, dir))) {
      if (!(dir === 'runtime' ? /\.cjs$/.test(file) || file === 'cli-manifest.json' : /\.js$/.test(file))) continue;
      fs.copyFileSync(path.join(source, dir, file), path.join(target, dir, file));
    }
  }
  fs.copyFileSync(path.join(source, 'package.json'), path.join(target, 'package.json'));
  atomic(path.join(target,'complete.json'),JSON.stringify({version}));
  }
  now ??= Date.now();
  let canPrune = false;
  try { canPrune = refreshTargets(root, versions, target, now); } catch {}
  const value = {schemaVersion:1, version, nodePath,
    entryPath:path.join(target, 'runtime', 'service-main.cjs'), adapterPath:path.join(target, 'runtime', 'service-adapter.cjs')};
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin, {recursive:true, mode:0o700});
  const launcher = path.join(bin, 'mcp-server.cjs');
  // Paths derive from this stable shim, preserving the caller's cwd and environment.
  atomic(launcher, "const fs=require('node:fs'),path=require('node:path');\nconst root=path.resolve(__dirname,'..');\ntry{const r=JSON.parse(fs.readFileSync(path.join(root,'installation.json'),'utf8'));require(r.adapterPath).main({root});}catch{process.stderr.write('service_install_required\\n');process.exitCode=1;}\n");
  atomic(path.join(root, 'installation.json'), JSON.stringify(value));
  let startup;
  try {
    if (canPrune) {
      startup = store.acquire('service-startup');
      pruneCopies(where, versions, target, now);
    }
  } catch {} finally {startup?.();}
  return {root, launcher, configuration:{mcpServers:{rundix:{command:nodePath, args:[launcher, '--service'], env:{ELECTRON_RUN_AS_NODE:'1'}}}}};
  } finally {unlock();}
}
function installLauncherAsync(options={}) {
  // Resolve in the caller; source-tree tests inject their root before the worker starts.
  options={...options,root:locations(options).directory};
  const {Worker}=require('node:worker_threads');
  return new Promise((resolve,reject)=>{
    const worker=new Worker(__filename,{workerData:{install:options}});
    // Let finally release the process-owned installation lease even if the UI
    // deadline expires. Terminating a worker would strand a live process lease.
    const timer=setTimeout(()=>{reject(Error('Service installation timed out.'));},30000);
    worker.once('message',value=>{clearTimeout(timer);value.error?reject(Object.assign(Error(value.error),{code:value.error})):resolve(value.result);});
    worker.once('error',()=>{clearTimeout(timer);reject(Error('Service installation failed.'));});
    worker.once('exit',code=>{if(code){clearTimeout(timer);reject(Error('Service installation failed.'));}});
  });
}
module.exports = {installLauncher, installLauncherAsync, registration};
const {isMainThread,workerData,parentPort}=require('node:worker_threads');
if(!isMainThread && workerData?.install) {
  try {parentPort.postMessage({result:installLauncher(workerData.install)});}
  catch(error) {parentPort.postMessage({error:error.code==='legacy_registry_busy'?error.code:'service_install_required'});}
}
