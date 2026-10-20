// Trusted installation only. Workspace input never selects an executable.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID,createHash} = require('node:crypto');
const {locations, protectDirectory} = require('./service-endpoint.cjs');
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
function installLauncher({source = path.join(__dirname, '..'), nodePath = process.execPath, root} = {}) {
  root = locations({root}).directory;
  protectDirectory(root);
  const store=new SessionStore(root),until=Date.now()+10000;let unlock;
  while(!unlock){try{unlock=store.acquire('service-install');}catch(error){if(Date.now()>=until)throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}
  try {
  const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
  // Keep running versions intact. The registration switches only after a complete copy.
  const files=['package.json',...['runtime','ui'].flatMap(dir=>fs.readdirSync(path.join(source,dir)).filter(file=>dir==='runtime'?/\.cjs$/.test(file)||file==='cli-manifest.json':/\.js$/.test(file)).sort().map(file=>dir+'/'+file))];
  const hash=createHash('sha256');for(const file of files)hash.update(file+'\0').update(fs.readFileSync(path.join(source,file)));
  const target = path.join(root, 'versions', version + '-' + hash.digest('hex').slice(0,24));
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
  const value = {schemaVersion:1, version, nodePath,
    entryPath:path.join(target, 'runtime', 'service-main.cjs'), adapterPath:path.join(target, 'runtime', 'service-adapter.cjs')};
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin, {recursive:true, mode:0o700});
  const launcher = path.join(bin, 'mcp-server.cjs');
  // Paths derive from this stable shim, preserving the caller's cwd and environment.
  atomic(launcher, "const fs=require('node:fs'),path=require('node:path');\nconst root=path.resolve(__dirname,'..');\ntry{const r=JSON.parse(fs.readFileSync(path.join(root,'installation.json'),'utf8'));require(r.adapterPath).main({root});}catch{process.stderr.write('service_install_required\\n');process.exitCode=1;}\n");
  atomic(path.join(root, 'installation.json'), JSON.stringify(value));
  // Prune only under the startup guard while there is no published owner.
  // Retain recent/registered runtimes; an active service prevents all pruning.
  let startup;
  try {
    startup=store.acquire('service-startup');
    if(!fs.existsSync(path.join(root,'bridge.json'))) {
      const versions=path.join(root,'versions');
      const entries=fs.readdirSync(versions).filter(name=>/^[0-9][\w.-]+$/.test(name)).map(name=>path.join(versions,name))
        .filter(file=>{const info=fs.lstatSync(file);return info.isDirectory()&&!info.isSymbolicLink();})
        .sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
      for(const file of entries.filter(file=>file!==target).slice(2)) {
        const relative=path.relative(path.resolve(versions),path.resolve(file));
        if(relative && !relative.startsWith('..') && !path.isAbsolute(relative))fs.rmSync(file,{recursive:true,force:true});
      }
    }
  } catch {} finally {startup?.();}
  return {root, launcher, configuration:{mcpServers:{rundix:{command:nodePath, args:[launcher, '--service'], env:{ELECTRON_RUN_AS_NODE:'1'}}}}};
  } finally {unlock();}
}
function installLauncherAsync(options={}) {
  const {Worker}=require('node:worker_threads');
  return new Promise((resolve,reject)=>{
    const worker=new Worker(__filename,{workerData:{install:options}});
    // Let finally release the process-owned installation lease even if the UI
    // deadline expires. Terminating a worker would strand a live process lease.
    const timer=setTimeout(()=>{reject(Error('Service installation timed out.'));},30000);
    worker.once('message',value=>{clearTimeout(timer);value.error?reject(Error('Service installation failed.')):resolve(value.result);});
    worker.once('error',()=>{clearTimeout(timer);reject(Error('Service installation failed.'));});
    worker.once('exit',code=>{if(code){clearTimeout(timer);reject(Error('Service installation failed.'));}});
  });
}
module.exports = {installLauncher, installLauncherAsync, registration};
const {isMainThread,workerData,parentPort}=require('node:worker_threads');
if(!isMainThread && workerData?.install) {
  try {parentPort.postMessage({result:installLauncher(workerData.install)});}
  catch {parentPort.postMessage({error:true});}
}
