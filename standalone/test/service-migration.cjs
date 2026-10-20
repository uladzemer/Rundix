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
async function blocked(migration,source,state){await migration.sync({force:true});assert.equal(migration.status(canonical(source)).state,state);}
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
    const oldBridge=old.acquire('mcp-bridge');await blocked(migration,source,'busy');assert(fs.existsSync(sourceTasks));oldBridge();
    const oldTurn=old.acquire('synthetic-chat-synthetic-a');await blocked(migration,source,'busy');oldTurn();await migration.close();
    // A real child exits mid-copy. The next owner reaps only its dead file lease.
    const crash=spawnSync(process.execPath,[__filename,'--crash',serviceRoot],{windowsHide:true,stdio:'pipe',timeout:10000});assert.equal(crash.status,17);
    assert(fs.existsSync(sourceTasks));assert(!fs.existsSync(path.join(source,'mcp','service-migration.json')));
    migration=createMigration({root:serviceRoot});await migration.sync();
    const sa=resolveSpace(a).spaceId,sb=resolveSpace(b).spaceId;
    const visible=migration.visible(sa,[canonical(a)]);assert.equal(visible.length,1);assert.equal(migration.visible(sb,[canonical(a)]).length,0);
    assert.equal(visible[0].session,undefined,'Imported sessions are not retained in the in-memory projection');
    assert.equal(visible[0].task.unsentInputs,undefined);assert.equal(visible[0].task.unsentInputCount,1);
    const legacySpace=migration.spaces([canonical(a)])[0];assert(legacySpace?.spaceId.startsWith('legacy:'));
    assert.equal(migration.visible(legacySpace.spaceId,[canonical(a)]).length,1);
    assert.equal(migration.visible(legacySpace.spaceId,[canonical(b)]).length,0);
    assert.throws(()=>old.acquire('mcp-bridge'),'Service holds v1 lease while alive');
    assert(!fs.existsSync(sourceTasks));const backup=fs.readdirSync(path.join(source,'mcp')).find(name=>name.startsWith('backup-'));assert(backup);
    assert.equal(fs.readdirSync(path.join(source,'mcp',backup,'tasks')).length,3);assert(old.session('synthetic-manual'));
    assert.equal((await migration.chat(sa,visible[0].taskId,[canonical(a)],'synthetic-generation')).readOnly,true);
    await assert.rejects(require('../runtime/mcp-bridge.cjs').request(path.join(source,'mcp','bridge.json'),'list_tasks',{}),{code:'adapter_upgrade_required'});
    assert.equal(require('../runtime/service-migration.cjs').legacyBridgeRoot(serviceRoot,path.join(source,'mcp','bridge.json')),canonical(source));
    const registryStore=new SessionStore(serviceRoot),registryLease=registryStore.acquire('legacy-roots');
    const contentionAt=Date.now();assert.throws(()=>require('../runtime/service-migration.cjs').legacyBridgeRoot(serviceRoot,path.join(source,'mcp','bridge.json'),{timeoutMs:40}),{code:'legacy_registry_busy'});
    assert(Date.now()-contentionAt<1000,'Lock contention has a bounded deadline');
    setTimeout(registryLease,80);await require('../runtime/service-migration.cjs').registerRootAsync(serviceRoot,source);
    const {Worker}=require('node:worker_threads'),{once}=require('node:events');
    const holder=new Worker("const {parentPort,workerData}=require('node:worker_threads');const release=new(require(workerData.module).SessionStore)(workerData.root).acquire('legacy-roots');parentPort.postMessage('held');setTimeout(()=>{release();parentPort.postMessage('released');},150);",{eval:true,workerData:{module:require.resolve('../runtime/store.cjs'),root:serviceRoot}});
    await once(holder,'message');registerRoot(serviceRoot,source);await once(holder,'exit');
    const readyLease=registryStore.acquire('legacy-roots');
    try{await migration.register(source);assert.equal(migration.status(canonical(source)).state,'ready','Registry contention cannot replace a completed import status');}finally{readyLease();}
    await migration.sync({force:true});assert.equal(migration.status(canonical(source)).state,'ready','Pending registration retry preserves ready status');
    let redundantReady=0;const unlisten=migration.onChanged(()=>redundantReady++);await migration.register(source);await migration.register(source);unlisten();assert.equal(redundantReady,0,'Repeated hello does not cause ready-event reconnect loops');
    assert.throws(()=>require('../runtime/service-migration.cjs').legacyBridgeRoot(serviceRoot,path.join(a,'mcp','bridge.json')),{code:'service_upgrade_required'});
    const imported=path.join(serviceRoot,'legacy',visible[0].sourceId);assert(!fs.readdirSync(imported).some(name=>name.includes('manual')));
    await migration.sync();await migration.close();migration=createMigration({root:serviceRoot});await migration.sync();assert.equal(migration.visible(sa,[canonical(a)]).length,1);
    // Cutover history does not re-infer a vanished project or re-import manual edits.
    const retired=path.join(base,'synthetic-retired'),storedFolder=canonical(a);fs.renameSync(a,retired);await migration.close();migration=createMigration({root:serviceRoot});await migration.sync();assert.equal(migration.visible(sa,[storedFolder]).length,1);fs.renameSync(retired,a);
    await migration.close();migration=null;const reacquired=old.acquire('mcp-bridge');reacquired();
    const data=require('./service-fixture.cjs').fixture(serviceRoot);
    try{
      service=await require('../runtime/service-main.cjs').runService({root:serviceRoot,hostOptions:data.hostOptions});
      for(const folder of [a,b]){const client=new ServiceWindowClient({root:serviceRoot,legacyRoot:source,trusted:true,workspaceFolders:[pathToFileURL(folder).href]});clients.push(client);await client.start();assert.equal(client.legacyStatus.state,'ready');}
      const [wa,wb]=clients;assert.equal(wa.snapshots.get(sa).tasks[0].readOnly,true);assert.equal(wb.snapshots.get(sb).tasks.length,1);
      wa.peer.close();const reconnectedBy=Date.now()+5000;while(!wa.peer || !wa.snapshots.has(sa)){assert(Date.now()<reconnectedBy,'Synthetic ready-root reconnect deadline');await new Promise(resolve=>setTimeout(resolve,20));}assert.equal(wa.legacyStatus.state,'ready');assert.equal(wb.legacyStatus.state,'ready');
      const open=fs.promises.open;let transcriptReads=0;
      try{
        fs.promises.open=async function(file,...args){if(String(file).includes(path.sep+'legacy'+path.sep))transcriptReads++;return open.call(this,file,...args);};
        await wa.refresh(sa);await wb.refresh(sb);assert.equal(transcriptReads,0,'Panel snapshots use metadata without opening imported transcripts');
        await wa.chat(sa,'chat.open',{taskId:wa.snapshots.get(sa).tasks[0].taskId});assert.equal(transcriptReads,1,'A chat reads only its own bounded stored record on demand');
      }finally{fs.promises.open=open;}
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
    // A stale running record is interrupted only after bridge and thread leases are acquired.
    const activeRoot=path.join(base,'service-active'),activeSource=path.join(base,'legacy-active');fs.mkdirSync(activeRoot);fs.mkdirSync(activeSource);seed(activeSource,'synthetic-active',a,{state:'running'});registerRoot(activeRoot,activeSource);
    const stale=createMigration({root:activeRoot});await stale.sync();assert.equal(stale.visible(sa,[canonical(a)])[0].interrupted,true);await stale.close();
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
    await blocked(changed,changedSource,'retry_later');assert(fs.existsSync(path.join(changedSource,'mcp','tasks')));assert(!fs.existsSync(path.join(changedSource,'mcp','service-migration.json')));await changed.close();
    const repaired=createMigration({root:changedRoot});await repaired.sync();assert.equal(repaired.visible(sa,[canonical(a)]).length,2);await repaired.close();
    // A completed receipt must verify both copied history and the retained backup.
    const changedId=fs.readdirSync(path.join(changedRoot,'legacy')).find(name=>/^[a-f0-9]{64}$/.test(name));
    const copiedFile=path.join(changedRoot,'legacy',changedId,'task-synthetic-original.json'),copiedBytes=fs.readFileSync(copiedFile);
    fs.writeFileSync(copiedFile,'{"syntheticCorruption":true}');
    const corruptCopy=createMigration({root:changedRoot});await blocked(corruptCopy,changedSource,'needs_repair');await corruptCopy.close();
    fs.writeFileSync(copiedFile,copiedBytes);
    const backupFile=path.join(changedSource,'mcp','backup-'+changedId,'tasks','mcp-task-synthetic-original.json'),backupBytes=fs.readFileSync(backupFile);
    fs.writeFileSync(backupFile,'{"syntheticBackupCorruption":true}');
    const corruptBackup=createMigration({root:changedRoot});await blocked(corruptBackup,changedSource,'needs_repair');await corruptBackup.close();
    fs.writeFileSync(backupFile,backupBytes);
    const verifiedAgain=createMigration({root:changedRoot});await verifiedAgain.sync();assert.equal(verifiedAgain.visible(sa,[canonical(a)]).length,2);await verifiedAgain.close();
    // A task must never turn an ordinary manual session into imported MCP history.
    const manualRoot=make('service-manual'),manualSource=make('legacy-manual');seed(manualSource,'synthetic-manual-reference',a);registerRoot(manualRoot,manualSource);
    const manualStore=new SessionStore(path.join(manualSource,'sessions-v1')),manualFile=manualStore.file('session','synthetic-session-synthetic-manual-reference');
    const manualSession=JSON.parse(fs.readFileSync(manualFile,'utf8'));manualSession.mcpTask=false;fs.writeFileSync(manualFile,JSON.stringify(manualSession));
    const manualImport=createMigration({root:manualRoot});await blocked(manualImport,manualSource,'needs_repair');await manualImport.close();
    assert(fs.existsSync(path.join(manualSource,'mcp','tasks')));assert(!fs.existsSync(path.join(manualSource,'mcp','service-migration.json')));
    // One unavailable root cannot prevent IPC or another root's history.
    const mixedRoot=make('service-mixed'),busySource=make('legacy-busy'),badSource=make('legacy-bad'),goneSource=make('legacy-gone'),healthySource=make('legacy-healthy');
    seed(busySource,'synthetic-busy',a);seed(badSource,'synthetic-bad',a);seed(healthySource,'synthetic-healthy',b);
    fs.writeFileSync(path.join(badSource,'mcp','tasks','mcp-task-synthetic-bad.json'),'{');
    for(const directory of [busySource,badSource,goneSource,healthySource])registerRoot(mixedRoot,directory);
    fs.rmdirSync(goneSource);
    const busyLease=new SessionStore(path.join(busySource,'sessions-v1')).acquire('mcp-bridge'),mixedData=require('./service-fixture.cjs').fixture(mixedRoot);
    let mixedService,mixedClient;try{
      mixedService=await require('../runtime/service-main.cjs').runService({root:mixedRoot,hostOptions:mixedData.hostOptions});
      mixedClient=new ServiceWindowClient({root:mixedRoot,legacyRoot:busySource,trusted:true,workspaceFolders:[pathToFileURL(a).href]});await mixedClient.start();
      assert.equal(mixedClient.legacyStatus.state,'busy');assert.equal(mixedClient.snapshots.get(sa).tasks.length,0);
      assert(!JSON.parse(fs.readFileSync(path.join(mixedRoot,'legacy-roots.json'),'utf8')).roots.includes(goneSource));
      const other=new ServiceWindowClient({root:mixedRoot,legacyRoot:badSource,trusted:true,workspaceFolders:[pathToFileURL(b).href]});
      try{await other.start();assert.equal(other.legacyStatus.state,'needs_repair');assert.equal(other.snapshots.get(sb).tasks.length,1);}finally{other.close();}
    }finally{mixedClient?.close();await mixedService?.shutdown();await mixedData.close();busyLease();}
    const retryRoot=make('service-retry'),retrySource=make('legacy-retry');seed(retrySource,'synthetic-retry',a);registerRoot(retryRoot,retrySource);
    let now=0,copies=0;
    const retrying=createMigration({root:retryRoot,clock:()=>now,hooks:{afterCopy(){if(++copies===1)throw Object.assign(Error('Synthetic temporary rename failure'),{code:'EBUSY'});}}});
    await retrying.sync();assert.equal(retrying.status(canonical(retrySource)).state,'retry_later');
    await retrying.sync();assert.equal(copies,1,'Backoff prevents an immediate retry');now=2000;await retrying.sync();assert.equal(retrying.status(canonical(retrySource)).state,'ready');await retrying.close();
    const additiveRoot=make('service-additive'),additiveSource=make('legacy-additive');seed(additiveSource,'synthetic-repeat',a);registerRoot(additiveRoot,additiveSource);
    let additive=createMigration({root:additiveRoot});await additive.sync();await additive.close();
    // Switching back creates a new active task directory alongside an immutable backup.
    seed(additiveSource,'synthetic-new',a);seed(additiveSource,'synthetic-repeat',a);
    const repeatedFile=path.join(additiveSource,'mcp','tasks','mcp-task-synthetic-repeat.json');
    const newer=JSON.parse(fs.readFileSync(repeatedFile,'utf8'));newer.progress='Synthetic newer generation';newer.updatedAt=2;fs.writeFileSync(repeatedFile,JSON.stringify(newer));
    additive=createMigration({root:additiveRoot});await additive.sync();
    assert.equal(additive.status(canonical(additiveSource)).state,'ready');assert.equal(additive.visible(sa,[canonical(a)]).length,2);
    assert.equal(additive.visible(sa,[canonical(a)]).find(row=>row.task.taskId==='synthetic-repeat').task.progress,'Synthetic newer generation');
    const backups=fs.readdirSync(path.join(additiveSource,'mcp')).filter(name=>name.startsWith('backup-'));assert.equal(backups.length,2);
    await additive.sync();await additive.close();additive=createMigration({root:additiveRoot});await additive.sync();assert.equal(additive.visible(sa,[canonical(a)]).length,2);
    // Reappearing older content is already imported and must not roll history back.
    seed(additiveSource,'synthetic-repeat',a);await additive.sync();
    assert.equal(additive.visible(sa,[canonical(a)]).find(row=>row.task.taskId==='synthetic-repeat').task.progress,'Synthetic newer generation');
    seed(additiveSource,'synthetic-repeat',a);fs.writeFileSync(repeatedFile,JSON.stringify(newer));
    const additiveSessions=new SessionStore(path.join(additiveSource,'sessions-v1')),transcript=additiveSessions.session('synthetic-session-synthetic-repeat');
    transcript.items.push({id:'synthetic-transcript-update',type:'agentMessage',text:'Synthetic transcript-only update'});additiveSessions.saveSession(transcript);
    await additive.sync();assert((await additive.chat(sa,additive.visible(sa,[canonical(a)]).find(row=>row.task.taskId==='synthetic-repeat').taskId,[canonical(a)],'synthetic-generation')).items.some(item=>item.text==='Synthetic transcript-only update'));await additive.close();
    seed(additiveSource,'synthetic-service-reenabled',a);
    const reenabledData=require('./service-fixture.cjs').fixture(additiveRoot);let reenabledService,reenabledClient;
    try{
      reenabledService=await require('../runtime/service-main.cjs').runService({root:additiveRoot,hostOptions:reenabledData.hostOptions});
      reenabledClient=new ServiceWindowClient({root:additiveRoot,legacyRoot:additiveSource,trusted:true,workspaceFolders:[pathToFileURL(a).href]});await reenabledClient.start();
      assert.equal(reenabledClient.legacyStatus.state,'ready');assert.equal(reenabledClient.snapshots.get(sa).tasks.length,3,'Re-enabled service imports recreated tasks and retains earlier generations');
      assert(reenabledClient.snapshots.get(sa).tasks.every(task=>task.readOnly));assert.equal(reenabledData.children.length,0);
    }finally{reenabledClient?.close();await reenabledService?.shutdown();await reenabledData.close();}
    const recopyRoot=make('service-recopy'),recopySource=make('legacy-recopy');seed(recopySource,'synthetic-changing',a);registerRoot(recopyRoot,recopySource);
    const recopyFile=path.join(recopySource,'mcp','tasks','mcp-task-synthetic-changing.json'),unboundedMetadata=JSON.parse(fs.readFileSync(recopyFile,'utf8'));
    unboundedMetadata.createdAt={synthetic:'x'.repeat(1024*1024)};unboundedMetadata.closedAt='x'.repeat(1024*1024);fs.writeFileSync(recopyFile,JSON.stringify(unboundedMetadata));
    let changedOnce=false;const recopy=createMigration({root:recopyRoot,hooks:{afterCopy(){if(changedOnce)return;changedOnce=true;
      const file=path.join(recopySource,'mcp','tasks','mcp-task-synthetic-changing.json'),row=JSON.parse(fs.readFileSync(file,'utf8'));row.progress='Synthetic changed during copy';fs.writeFileSync(file,JSON.stringify(row));
    }}});
    await recopy.sync();assert.equal(recopy.status(canonical(recopySource)).state,'retry_later');await recopy.sync({force:true});
    assert.equal(recopy.visible(sa,[canonical(a)])[0].task.progress,'Synthetic changed during copy');
    assert.equal(recopy.visible(sa,[canonical(a)])[0].task.createdAt,0);assert.equal(recopy.visible(sa,[canonical(a)])[0].task.closedAt,null);
    const readySource=canonical(recopySource);fs.renameSync(recopySource,path.join(base,'legacy-recopy-retired'));await recopy.sync();
    assert.equal(recopy.status(readySource).state,'vanished');assert(!JSON.parse(fs.readFileSync(path.join(recopyRoot,'legacy-roots.json'),'utf8')).roots.includes(readySource));await recopy.close();
    const probeRoot=make('service-probes'),probeA=make('legacy-probe-a'),probeB=make('legacy-probe-b');seed(probeA,'synthetic-probe-a',a);seed(probeB,'synthetic-probe-b',b);registerRoot(probeRoot,probeA);registerRoot(probeRoot,probeB);
    const probes=createMigration({root:probeRoot});await probes.sync();seed(probeB,'synthetic-probe-new',b);
    const lstat=fs.promises.lstat;let injected=false;
    try{fs.promises.lstat=async function(file,...args){if(String(file)===path.join(canonical(probeA),'mcp','tasks')){injected=true;throw Object.assign(Error('Synthetic permission denial'),{code:'EACCES'});}return lstat.call(this,file,...args);};await probes.sync({force:true});}
    finally{fs.promises.lstat=lstat;}
    assert(injected);assert.equal(probes.visible(sb,[canonical(b)]).length,2,'An inaccessible ready-root probe cannot starve another generation');
    await probes.close();
    const registryRoot=make('service-registry'),registrySource=make('legacy-registry');seed(registrySource,'synthetic-registry',a);
    fs.writeFileSync(path.join(registryRoot,'legacy-roots.json'),'{');const registry=createMigration({root:registryRoot});await registry.sync();await registry.register(registrySource);
    assert.equal(registry.status(canonical(registrySource)).state,'needs_repair');
    fs.writeFileSync(path.join(registryRoot,'legacy-roots.json'),JSON.stringify({schemaVersion:1,roots:[]}));await registry.sync({force:true});
    assert.equal(registry.status(canonical(registrySource)).state,'ready');assert.equal(registry.visible(sa,[canonical(a)]).length,1,'Pending first registration retries after registry repair');await registry.close();
    console.log('PASS legacy migration: real mid-copy process crash, idempotent verify/marker/backup, live bridge/turn gates, lifetime lease, read-only inferred/unknown spaces, A/B isolation and no queued execution.');
  }finally{await migration?.close();clients.forEach(client=>client.close());await service?.shutdown();assert.equal(path.dirname(base),os.tmpdir());assert(path.basename(base).startsWith('rundix-migration-synthetic-'));fs.rmSync(base,{recursive:true,force:true});}
}
