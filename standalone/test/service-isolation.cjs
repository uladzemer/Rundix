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
(async()=>{
try {
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
  console.log('PASS isolation: source-only overrides, production/installed override rejection, stripped child environment; guard detects creation/modification/deletion and skips junction targets.');
} finally {fs.rmSync(root,{recursive:true,force:true});}

})().catch(error=>{console.error(error);process.exitCode=1;});
