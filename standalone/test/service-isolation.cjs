require('./test-isolation.cjs').isolate();
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawnSync} = require('node:child_process');
const {snapshot, assertUnchanged} = require('./test-isolation.cjs');
const {servicePaths} = require('../runtime/service-paths.cjs');
const {locations} = require('../runtime/service-endpoint.cjs');
const {configLocation} = require('../runtime/service-provider-config.cjs');
const {serviceEnvironment} = require('../runtime/service-environment.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(),'rundix-guard-synthetic-'));
async function checkRootCleanup() {
  const {cleanupServiceRoot} = require('../runtime/service-root-cleanup.cjs');
  const disk = require('node:fs/promises');
  const directory = path.join(root,'cleanup');fs.mkdirSync(directory);
  const uuid = i => `00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
  const tmp = (base,i) => `${base}.${uuid(i)}.tmp`;
  const backup = i => `legacy-roots.json.cleanup-${uuid(i)}.bak`;
  const now = () => Date.UTC(2026,0,1), day = 86400000;
  const old = [tmp('bridge.json',1),tmp('settings.json',1),tmp('installation.json',1),tmp('legacy-roots.json',1),
    tmp('lease-service-startup.json',1),`lease-service-install.json.reap.123-${uuid(1)}.tmp`,backup(1)];
  const busy = tmp('bridge.json',2), changed = backup(4), young = tmp('bridge.json',3), newest = backup(2);
  const kept = ['bridge.json','installation.json','legacy-roots.json','settings.json','lease-legacy-roots.json',
    `bridge.json.stale-${uuid(1)}`,`bridge.json.${uuid(1)}.tmp.extra`,tmp('unrelated.json',1),'bridge.json.abc.tmp',young,busy,changed,newest];
  const touch = (file,age) => fs.utimesSync(file,new Date(now()-age*day),new Date(now()-age*day));
  for (const name of [...old,...kept]) {
    const file = path.join(directory,name);fs.writeFileSync(file,'SYNTHETIC');
    touch(file,name===young?30:name===newest?35:40);
  }
  const nested = tmp('bridge.json',4);fs.mkdirSync(path.join(directory,nested));
  fs.writeFileSync(path.join(directory,nested,old[0]),'SYNTHETIC');
  touch(path.join(directory,nested),40);touch(path.join(directory,nested,old[0]),40);kept.push(nested);
  const symlink = tmp('bridge.json',5);
  try {
    const link = path.join(directory,symlink);fs.symlinkSync(path.join(directory,'bridge.json'),link,'file');kept.push(symlink);
    fs.lutimesSync(link,new Date(now()-40*day),new Date(now()-40*day));
  }
  catch (error) {if (!['EPERM','EACCES','ENOSYS'].includes(error.code)) throw error;}
  let changedStats = 0;
  const files = {opendir:disk.opendir,
    lstat:async file=>{if(path.basename(file)===changed && ++changedStats===2)touch(file,31);return disk.lstat(file);},
    unlink:async file=>{if(path.basename(file)===busy)throw Object.assign(Error(),{code:'EBUSY'});await disk.unlink(file);}};
  assert.equal(await cleanupServiceRoot(directory,{now,files,maxEntries:0}),0);
  assert.equal(await cleanupServiceRoot(directory,{now,files}),old.length);
  assert.deepEqual(fs.readdirSync(directory).sort(),kept.sort());
  assert(fs.existsSync(path.join(directory,nested,old[0])));
  assert.equal(changedStats,2);
  console.log('PASS service root cleanup: bounded metadata-only scan, age and exact names, backup retention, recheck and busy files');
}
(async()=>{
try {
  await checkRootCleanup();
  const watched = [path.join(root,'local'),path.join(root,'roaming')];
  let before = snapshot(watched); assertUnchanged(before,watched);
  fs.mkdirSync(watched[0]); assert.throws(() => assertUnchanged(before,watched),/guard FAILED/);
  fs.mkdirSync(watched[1]);
  const provider = path.join(watched[1],'provider.json');fs.writeFileSync(provider,'SYNTHETIC');
  before = snapshot(watched);assertUnchanged(before,watched); // existing provider tolerated
  fs.utimesSync(provider,new Date(100000),new Date(100000));
  assert.throws(() => assertUnchanged(before,watched),/guard FAILED/);
  before = snapshot(watched);fs.unlinkSync(provider);assert.throws(() => assertUnchanged(before,watched),/guard FAILED/);
  fs.symlinkSync(watched[1],path.join(watched[0],'link'),process.platform === 'win32' ? 'junction' : 'dir');
  before = snapshot([watched[0]]);fs.writeFileSync(path.join(watched[1],'outside'),'SYNTHETIC');assertUnchanged(before,[watched[0]]);
  const service = path.join(watched[0],'service');fs.mkdirSync(service);
  const workingFiles = ['diagnostics/service-0.log','state/meta-synthetic.json',
    'sessions-v1/session-synthetic.json','mcp/tasks/mcp-task-synthetic.json',
    'migrations/synthetic.json','legacy/synthetic/task-synthetic.json',
    'versions/0.0.0-synthetic/runtime/service-main.cjs','bridge.json','legacy-roots.json',
    'lease-legacy-roots.json','lease-service-startup.json','lease-service-install.json',
    'bridge.json.00000000-0000-4000-8000-000000000000.tmp',
    'lease-legacy-roots.json.reap.123-00000000-0000-4000-8000-000000000000.tmp/owner'];
  const writeWorking = () => {
    for (const name of workingFiles) {
      const file=path.join(service,name);fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.appendFileSync(file,'SYNTHETIC service write\n');
    }
  };
  before=snapshot(watched);writeWorking();assertUnchanged(before,watched);
  writeWorking();assertUnchanged(before,watched);
  for (const name of workingFiles) fs.unlinkSync(path.join(service,name));
  assertUnchanged(before,watched);
  const protectedFiles = [path.join(service,'settings.json'),path.join(service,'installation.json'),
    path.join(service,'bin','mcp-server.cjs'),path.join(service,'bin','unexpected.cjs'),
    path.join(watched[1],'rundix-service','provider.json'),
    path.join(service,'providers','synthetic','provider.json'),
    path.join(watched[1],'providers','synthetic','provider.json'),
    path.join(service,'unexpected','synthetic.json'),path.join(watched[0],'unexpected.json')];
  for (const file of protectedFiles) {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    before=snapshot(watched);fs.writeFileSync(file,'SYNTHETIC test leak');writeWorking();
    assert.throws(()=>assertUnchanged(before,watched),/guard FAILED/,'Creation must fail alongside live writes');
    before=snapshot(watched);fs.appendFileSync(file,' modified');writeWorking();
    assert.throws(()=>assertUnchanged(before,watched),/guard FAILED/,'Modification must fail alongside live writes');
    before=snapshot(watched);fs.unlinkSync(file);writeWorking();
    assert.throws(()=>assertUnchanged(before,watched),/guard FAILED/,'Deletion must fail alongside live writes');
  }
  before=snapshot(watched);
  assert(!JSON.stringify(before).includes('synthetic'),'Snapshots contain hashed names only');
  const originalRead=fs.readFileSync;
  try {
    fs.readFileSync=()=>assert.fail('Guard must not read file contents');
    assertUnchanged(before,watched);
  } finally {fs.readFileSync=originalRead;}
  const defaults = servicePaths({pathEnv:{},platform:'win32',home:root,localAppData:path.join(root,'local'),appData:path.join(root,'roaming')});
  assert.equal(defaults.directory,path.join(root,'local','Rundix','service'));
  assert.equal(defaults.providerConfig,path.join(root,'roaming','Rundix','rundix-service','provider.json'));
  assert.equal(servicePaths().directory,process.env.RUNDIX_SERVICE_ROOT);
  const productionRoot=path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),'Rundix','service');
  if(process.platform==='win32')assert.throws(()=>servicePaths({root:productionRoot}),/cannot use the production service root/);
  assert.equal(configLocation(),path.join(process.env.RUNDIX_PROVIDER_CONFIG_DIR,'provider.json'));
  assert.equal(servicePaths({root}).directory,root,'Explicit root takes precedence');
  const options = {platform:'win32',sid:'S-1-5-21-42420',root:defaults.directory};
  const production = locations({...options,pathEnv:{},localAppData:path.join(root,'local')});
  const isolated = locations({...options,root});
  assert.notEqual(isolated.address,production.address,'Temporary roots isolate IPC without environment-controlled namespaces');
  const launcher = require('../runtime/service-launcher.cjs').installLauncher();
  assert.equal(launcher.root,process.env.RUNDIX_SERVICE_ROOT,'Launcher without options uses the isolated default');
  assert(fs.existsSync(path.join(path.dirname(require('../runtime/service-launcher.cjs').registration(launcher.root).entryPath),'service-paths.cjs')));
  assert.throws(() => require('../runtime/service-provider-config.cjs').readProviderConfig(),{code:'PROVIDER_NOT_CONFIGURED'});
  const contract = require('./production-service-contract.cjs');
  contract.validatePaths(fs.readFileSync(require.resolve('../runtime/service-paths.cjs'),'utf8'));
  const installedRuntime = path.dirname(require('../runtime/service-launcher.cjs').registration(launcher.root).entryPath);
  contract.validatePaths(fs.readFileSync(path.join(installedRuntime,'service-paths.cjs'),'utf8'));
  contract.validateEnvironment(fs.readFileSync(require.resolve('../runtime/service-environment.cjs'),'utf8'));
  await assert.rejects(require('../runtime/service-provider-config.cjs').readProviderConfigAsync(),{code:'PROVIDER_NOT_CONFIGURED'});
  assert.equal((await require('../runtime/service-launcher.cjs').installLauncherAsync()).root,process.env.RUNDIX_SERVICE_ROOT);
  const inherited = serviceEnvironment({...process.env,rundix_unknown:'synthetic'});
  assert(!Object.keys(inherited).some(key=>/^RUNDIX_/i.test(key)));
  const child = spawnSync(process.execPath,['-e',
    "const assert=require('node:assert/strict');assert(!Object.keys(process.env).some(key=>/^RUNDIX_/i.test(key)));"],
    {env:inherited,windowsHide:true,stdio:'pipe',timeout:10000});
  assert.equal(child.status,0,'Filtered service children never receive RUNDIX_*');
  console.log('PASS isolation: source-only overrides, production/installed override rejection, stripped child environment; metadata guard tolerates live service writes, detects concurrent configuration/bin/provider/unknown-entry leaks, and skips junction targets.');
} finally {fs.rmSync(root,{recursive:true,force:true});}

})().catch(error=>{console.error(error);process.exitCode=1;});
