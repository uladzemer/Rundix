// All roots, sessions and text below are explicitly synthetic.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {SessionStore}=require('../runtime/store.cjs');
const {createMigration,registerRoot}=require('../runtime/service-migration.cjs');
const {resolveSpace,canonical}=require('../runtime/service-space.cjs');
const {ServiceWindowClient}=require('../runtime/service-window-client.cjs');
const {pathToFileURL}=require('node:url');
function seed(source,id,directory,{state='completed'}={}){
  directory=fs.existsSync(directory)?canonical(directory):path.join(canonical(path.dirname(directory)),path.basename(directory));
  const tasks=new SessionStore(path.join(source,'mcp','tasks')),sessions=new SessionStore(path.join(source,'sessions-v1'));
  const sessionKey='synthetic-session-'+id,chatId='synthetic-chat-'+id;
  tasks.write('mcp-task',id,{taskId:id,sessionKey,chatId,state,description:'Synthetic legacy task '+id,projectDirectory:directory,
    operations:[{requestId:'synthetic-request-'+id}],createdAt:1,progress:'Synthetic legacy progress',continuations:['Synthetic queued input'],unsentInputs:[{id:'synthetic-unsent',text:'Synthetic unsent input'}]});
  sessions.saveSession({key:sessionKey,id:chatId,mcpTask:true,cwd:directory,items:[{id:'synthetic-item-'+id,type:'agentMessage',text:'Synthetic legacy transcript'}]});
}
if(process.argv[2]==='--crash'){
  const migration=createMigration({root:process.argv[3],hooks:{afterCopy(){process.exit(17);}}});
  void migration.sync().catch(()=>process.exit(18));
}else main().catch(error=>{console.error(error);process.exitCode=1;});
async function main(){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-migration-synthetic-'));
  const serviceRoot=path.join(base,'service'),source=path.join(base,'legacy'),a=path.join(base,'synthetic-a'),b=path.join(base,'synthetic-b');
  for(const folder of [serviceRoot,source,a,b])fs.mkdirSync(folder);for(const folder of [a,b])fs.mkdirSync(path.join(folder,'.git'));
  const old=new SessionStore(path.join(source,'sessions-v1'));let migration,service;const clients=[];
  const sourceTasks=path.join(source,'mcp','tasks');
  try{
    seed(source,'synthetic-a',a);seed(source,'synthetic-b',b);seed(source,'synthetic-unknown',path.join(a,'synthetic-deleted'));
    old.saveSession({key:'synthetic-manual',id:'synthetic-manual-chat',items:[{id:'synthetic-manual-item',type:'userMessage',content:[{type:'text',text:'Synthetic manual chat'}]}]});
    registerRoot(serviceRoot,source);migration=createMigration({root:serviceRoot});
    const oldBridge=old.acquire('mcp-bridge');await assert.rejects(migration.sync(),{code:'legacy_owner_active'});assert(fs.existsSync(sourceTasks));oldBridge();
    const oldTurn=old.acquire('synthetic-chat-synthetic-a');await assert.rejects(migration.sync(),{code:'legacy_owner_active'});oldTurn();await migration.close();
    // A real child exits mid-copy. The next owner reaps only its dead file lease.
    const crash=spawnSync(process.execPath,[__filename,'--crash',serviceRoot],{windowsHide:true,stdio:'pipe',timeout:10000});assert.equal(crash.status,17);
    assert(fs.existsSync(sourceTasks));assert(!fs.existsSync(path.join(source,'mcp','service-migration.json')));
    migration=createMigration({root:serviceRoot});await migration.sync();
    const sa=resolveSpace(a).spaceId,sb=resolveSpace(b).spaceId;
    const visible=migration.visible(sa,[canonical(a)]);assert.equal(visible.length,1);assert.equal(migration.visible(sb,[canonical(a)]).length,0);
    const legacySpace=migration.spaces([canonical(a)])[0];assert(legacySpace?.spaceId.startsWith('legacy:'));
    assert.equal(migration.visible(legacySpace.spaceId,[canonical(a)]).length,1);
    assert.equal(migration.visible(legacySpace.spaceId,[canonical(b)]).length,0);
    assert.throws(()=>old.acquire('mcp-bridge'),'Service holds v1 lease while alive');
    assert(!fs.existsSync(sourceTasks));const backup=fs.readdirSync(path.join(source,'mcp')).find(name=>name.startsWith('backup-'));assert(backup);
    assert.equal(fs.readdirSync(path.join(source,'mcp',backup,'tasks')).length,3);assert(old.session('synthetic-manual'));
    assert.equal(migration.chat(sa,visible[0].taskId,[canonical(a)],'synthetic-generation').readOnly,true);
    await assert.rejects(require('../runtime/mcp-bridge.cjs').request(path.join(source,'mcp','bridge.json'),'list_tasks',{}),{code:'adapter_upgrade_required'});
    assert.equal(require('../runtime/service-migration.cjs').legacyBridgeRoot(serviceRoot,path.join(source,'mcp','bridge.json')),canonical(source));
    assert.throws(()=>require('../runtime/service-migration.cjs').legacyBridgeRoot(serviceRoot,path.join(a,'mcp','bridge.json')),{code:'service_upgrade_required'});
    const imported=path.join(serviceRoot,'legacy',visible[0].sourceId);assert(!fs.readdirSync(imported).some(name=>name.includes('manual')));
    await migration.sync();await migration.close();migration=createMigration({root:serviceRoot});await migration.sync();assert.equal(migration.visible(sa,[canonical(a)]).length,1);
    // Cutover history does not re-infer a vanished project or re-import manual edits.
    const retired=path.join(base,'synthetic-retired'),storedFolder=canonical(a);fs.renameSync(a,retired);await migration.close();migration=createMigration({root:serviceRoot});await migration.sync();assert.equal(migration.visible(sa,[storedFolder]).length,1);fs.renameSync(retired,a);
    await migration.close();migration=null;const reacquired=old.acquire('mcp-bridge');reacquired();
    const data=require('./service-fixture.cjs').fixture(serviceRoot);
    try{
      service=await require('../runtime/service-main.cjs').runService({root:serviceRoot,hostOptions:data.hostOptions});
      for(const folder of [a,b]){const client=new ServiceWindowClient({root:serviceRoot,trusted:true,workspaceFolders:[pathToFileURL(folder).href]});clients.push(client);await client.start();}
      const [wa,wb]=clients;assert.equal(wa.snapshots.get(sa).tasks[0].readOnly,true);assert.equal(wb.snapshots.get(sb).tasks.length,1);
      const id=wa.snapshots.get(sa).tasks[0].taskId;assert.equal((await wa.chat(sa,'chat.open',{taskId:id})).owner,'legacy');
      await assert.rejects(wb.chat(sb,'chat.open',{taskId:id}),{code:'unknown_task'});
      await assert.rejects(wa.call(sa,'continue_task',{taskId:id,requestId:'synthetic-forbidden',clarification:'Synthetic forbidden execution'}),{code:'unknown_task'});
      assert.equal(service.host.mcp.tasks.tasks.size,0);assert.equal(data.children.length,0,'Migrated queued inputs never start provider/CLI');
      assert.throws(()=>old.acquire('mcp-bridge'));
    }finally{clients.forEach(client=>client.close());await service?.shutdown();service=null;await data.close();}
    const release=old.acquire('mcp-bridge');release();
    // Verify→marker crash resumes one backup move, without a second import.
    const nextRoot=path.join(base,'service-next'),nextSource=path.join(base,'legacy-next');fs.mkdirSync(nextRoot);fs.mkdirSync(nextSource);seed(nextSource,'synthetic-next',a);registerRoot(nextRoot,nextSource);
    const interrupted=createMigration({root:nextRoot,hooks:{afterMarker(){throw Error('Synthetic marker crash');}}});
    await assert.rejects(interrupted.sync(),/Synthetic marker crash/);await interrupted.close();assert(fs.existsSync(path.join(nextSource,'mcp','tasks')));
    const resumed=createMigration({root:nextRoot});await resumed.sync();assert(!fs.existsSync(path.join(nextSource,'mcp','tasks')));await resumed.close();
    // Live/unverified old execution is never inferred dead merely from an absent bridge.
    const activeRoot=path.join(base,'service-active'),activeSource=path.join(base,'legacy-active');fs.mkdirSync(activeRoot);fs.mkdirSync(activeSource);seed(activeSource,'synthetic-active',a,{state:'running'});registerRoot(activeRoot,activeSource);
    const blocked=createMigration({root:activeRoot});await assert.rejects(blocked.sync(),{code:'legacy_owner_active'});assert(fs.existsSync(path.join(activeSource,'mcp','tasks')));await blocked.close();
    const make=name=>{const directory=path.join(base,name);fs.mkdirSync(directory);return directory;};
    const concurrentRoot=make('service-concurrent'),first=make('legacy-first'),second=make('legacy-second');seed(first,'synthetic-first',a);seed(second,'synthetic-second',b);registerRoot(concurrentRoot,first);
    let unblock,copied;const gate=new Promise(resolve=>unblock=resolve),reached=new Promise(resolve=>copied=resolve);
    const concurrent=createMigration({root:concurrentRoot,hooks:{afterCopy(){copied();return gate;}}});
    const firstRun=concurrent.sync();await reached;const secondRun=concurrent.register(second);unblock();await Promise.all([firstRun,secondRun]);concurrent.assertReady();
    assert.equal(concurrent.visible(sb,[canonical(b)]).length,1,'Concurrent registration waits for its own root');await concurrent.close();
    const closingRoot=make('service-closing'),closingSource=make('legacy-closing');seed(closingSource,'synthetic-closing',a);registerRoot(closingRoot,closingSource);
    let resumeClose,copyStarted;const closeGate=new Promise(resolve=>resumeClose=resolve),closeReached=new Promise(resolve=>copyStarted=resolve);
    const quiescent=createMigration({root:closingRoot,hooks:{afterCopy(){copyStarted();return closeGate;}}});
    const inFlight=quiescent.sync();await closeReached;const closing=quiescent.close();
    const closingStore=new SessionStore(path.join(closingSource,'sessions-v1'));assert.throws(()=>closingStore.acquire('mcp-bridge'),'Shutdown keeps lease until copying settles');
    resumeClose();await Promise.all([inFlight,closing]);const afterClose=closingStore.acquire('mcp-bridge');afterClose();
    const changedRoot=make('service-changed'),changedSource=make('legacy-changed');seed(changedSource,'synthetic-original',a);registerRoot(changedRoot,changedSource);
    const changed=createMigration({root:changedRoot,hooks:{afterCopy(){seed(changedSource,'synthetic-added',a);}}});
    await assert.rejects(changed.sync(),{code:'migration_conflict'});assert(fs.existsSync(path.join(changedSource,'mcp','tasks')));assert(!fs.existsSync(path.join(changedSource,'mcp','service-migration.json')));await changed.close();
    const repaired=createMigration({root:changedRoot});await repaired.sync();assert.equal(repaired.visible(sa,[canonical(a)]).length,2);await repaired.close();
    // A completed receipt must verify both copied history and the retained backup.
    const changedId=fs.readdirSync(path.join(changedRoot,'legacy')).find(name=>/^[a-f0-9]{64}$/.test(name));
    const copiedFile=path.join(changedRoot,'legacy',changedId,'task-synthetic-original.json'),copiedBytes=fs.readFileSync(copiedFile);
    fs.writeFileSync(copiedFile,'{"syntheticCorruption":true}');
    const corruptCopy=createMigration({root:changedRoot});await assert.rejects(corruptCopy.sync(),{code:'migration_conflict'});await corruptCopy.close();
    fs.writeFileSync(copiedFile,copiedBytes);
    const backupFile=path.join(changedSource,'mcp','backup-'+changedId,'tasks','mcp-task-synthetic-original.json'),backupBytes=fs.readFileSync(backupFile);
    fs.writeFileSync(backupFile,'{"syntheticBackupCorruption":true}');
    const corruptBackup=createMigration({root:changedRoot});await assert.rejects(corruptBackup.sync(),{code:'migration_conflict'});await corruptBackup.close();
    fs.writeFileSync(backupFile,backupBytes);
    const verifiedAgain=createMigration({root:changedRoot});await verifiedAgain.sync();assert.equal(verifiedAgain.visible(sa,[canonical(a)]).length,2);await verifiedAgain.close();
    // A task must never turn an ordinary manual session into imported MCP history.
    const manualRoot=make('service-manual'),manualSource=make('legacy-manual');seed(manualSource,'synthetic-manual-reference',a);registerRoot(manualRoot,manualSource);
    const manualStore=new SessionStore(path.join(manualSource,'sessions-v1')),manualFile=manualStore.file('session','synthetic-session-synthetic-manual-reference');
    const manualSession=JSON.parse(fs.readFileSync(manualFile,'utf8'));manualSession.mcpTask=false;fs.writeFileSync(manualFile,JSON.stringify(manualSession));
    const manualImport=createMigration({root:manualRoot});await assert.rejects(manualImport.sync(),{code:'migration_conflict'});await manualImport.close();
    assert(fs.existsSync(path.join(manualSource,'mcp','tasks')));assert(!fs.existsSync(path.join(manualSource,'mcp','service-migration.json')));
    console.log('PASS legacy migration: real mid-copy process crash, idempotent verify/marker/backup, live bridge/turn gates, lifetime lease, read-only inferred/unknown spaces, A/B isolation and no queued execution.');
  }finally{await migration?.close();clients.forEach(client=>client.close());await service?.shutdown();assert.equal(path.dirname(base),os.tmpdir());assert(path.basename(base).startsWith('rundix-migration-synthetic-'));fs.rmSync(base,{recursive:true,force:true});}
}
