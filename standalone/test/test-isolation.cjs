// Metadata only: never open user files, and never follow junctions/symlinks.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {createHash, randomUUID} = require('node:crypto');
function realRoots(env = process.env) {
  const home = os.homedir();
  if (process.platform === 'win32') return [
    path.join(env.LOCALAPPDATA || path.join(home,'AppData','Local'),'Rundix'),
    path.join(env.APPDATA || path.join(home,'AppData','Roaming'),'Rundix')];
  return process.platform === 'darwin' ? [path.join(home,'Library','Application Support','Rundix')]
    : [path.join(home,'.local','state','Rundix'), path.join(home,'.config','Rundix')];
}
function snapshot(roots = realRoots()) {
  const result = {};
  function visit(file, key) {
    let info;
    try {info = fs.lstatSync(file, {bigint:true});} catch (error) {if (error.code === 'ENOENT') return; throw error;}
    // Hash names so even the saved metadata does not disclose personal paths.
    const id = createHash('sha256').update(key).digest('hex');
    result[id] = [info.mtimeNs,info.ctimeNs,info.birthtimeNs,info.size,info.mode,info.ino].map(String);
    if (info.isDirectory() && !info.isSymbolicLink())
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file,name),key+'/'+name);
  }
  roots.forEach((root,index) => visit(root,String(index)));
  return result;
}
function assertUnchanged(before, roots) {
  const after = snapshot(roots), keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let changed = 0;
  for (const key of keys) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed++;
  if (changed) throw Error(`Real-root guard FAILED: ${changed} metadata entries changed; user file contents were not read.`);
}
let active;
function isolate() {
  if (active) return active;
  const before = snapshot();
  // An inherited complete isolation belongs to the outer runner/host harness.
  const inherited = process.env.RUNDIX_TEST_ISOLATED === '1' &&
    ['RUNDIX_SERVICE_ROOT','RUNDIX_PROVIDER_CONFIG_DIR','RUNDIX_SERVICE_ENDPOINT_NAMESPACE'].every(key => process.env[key]);
  const root = inherited ? null : fs.mkdtempSync(path.join(os.tmpdir(),'rundix-test-isolation-'));
  if (root) Object.assign(process.env, {RUNDIX_TEST_ISOLATED:'1', RUNDIX_SERVICE_ROOT:path.join(root,'service'),
    RUNDIX_PROVIDER_CONFIG_DIR:path.join(root,'provider-config'), RUNDIX_SERVICE_ENDPOINT_NAMESPACE:randomUUID()});
  // Mutate only the source-tree module export, never copied/installed runtimes.
  // No runtime file imports this helper; it is absent from the VSIX.
  const sourcePaths = require('../runtime/service-paths.cjs');
  const productionPaths = sourcePaths.servicePaths;
  sourcePaths.servicePaths = (options = {}) => {
    const env = options.pathEnv || process.env;
    const paths = productionPaths({...options,root:options.root || env.RUNDIX_SERVICE_ROOT});
    if (env.RUNDIX_PROVIDER_CONFIG_DIR) paths.providerConfig = path.join(path.resolve(env.RUNDIX_PROVIDER_CONFIG_DIR),'provider.json');
    // A unique temporary root already namespaces IPC, including installed copies.
    return paths;
  };
  active = {before, root};
  process.on('exit', () => {
    try {assertUnchanged(before); console.log('PASS real-root guard: unchanged (metadata only).');}
    catch (error) {console.error(error.message);process.exitCode = 1;}
    finally {if (root) fs.rmSync(root,{recursive:true,force:true});}
  });
  return active;
}
module.exports = {realRoots, snapshot, assertUnchanged, isolate};
