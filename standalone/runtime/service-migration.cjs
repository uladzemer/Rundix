// Explicit legacy roots only. Imported records never enter the task executor.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {SessionStore}=require('./store.cjs');
const {canonical,resolveSpace}=require('./service-space.cjs');
const {parseStrict}=require('./service-json.cjs');
const projection=require('./service-projection.cjs');
const key=value=>typeof value==='string' && /^[\w-]{1,128}$/.test(value);
const failure=code=>Object.assign(Error(code==='legacy_owner_active'?'Stop the legacy MCP bridge and finish its active chats before retrying.':'Legacy history migration requires repair; source data was preserved.'),{code});
const stable=value=>value && typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const json=value=>JSON.stringify(stable(value));
const digest=value=>createHash('sha256').update(json(value)).digest('hex');
function roots(store){
  const file=store.file('legacy','roots');
  if(fs.existsSync(file) && fs.lstatSync(file).size>1024*1024)throw failure('migration_conflict');
  const value=store.read('legacy','roots');
  if(!value && !fs.existsSync(file))return [];
  if(value?.schemaVersion!==1 || !Array.isArray(value.roots) || value.roots.length>100 || value.roots.some(root=>typeof root!=='string' || !path.isAbsolute(root)))throw failure('migration_conflict');
  return value.roots;
}
function registryBusy(){return Object.assign(Error('legacy_registry_busy'),{code:'legacy_registry_busy',retryable:true});}
const jitter=attempt=>Math.min(150,20*2**Math.min(attempt,3))+Math.floor(Math.random()*30);
function registerRoot(root,source,{timeoutMs=1500}={}){
  source=canonical(source);const target=canonical(root);
  if(contains([source],target) || contains([target],source))throw failure('migration_conflict');
  const store=new SessionStore(root),deadline=Date.now()+timeoutMs;let release,attempt=0;
  while(!release){try{release=store.acquire('legacy-roots');}catch(error){
    if(error.code && !['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
    if(Date.now()>=deadline)throw registryBusy();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(jitter(attempt++),deadline-Date.now()));
  }}
  try{const list=roots(store);if(!list.includes(source)){if(list.length>=100)throw failure('migration_conflict');store.write('legacy','roots',{schemaVersion:1,roots:[...list,source]});}}
  finally{release();}
  return source;
}
async function registerRootAsync(root,source,{timeoutMs=1500}={}){
  const deadline=Date.now()+timeoutMs;let attempt=0;
  for(;;){try{return registerRoot(root,source,{timeoutMs:0});}catch(error){
    if(error.code!=='legacy_registry_busy' || Date.now()>=deadline)throw error;
    await new Promise(resolve=>setTimeout(resolve,Math.min(jitter(attempt++),deadline-Date.now())));
  }}
}
async function read(file){
  const info=await fsp.lstat(file);if(!info.isFile() || info.isSymbolicLink() || info.size>16*1024*1024)throw failure('migration_conflict');
  const handle=await fsp.open(file,'r');
  try{
    const bytes=Buffer.alloc(info.size+1);let size=0;
    while(size<bytes.length){const {bytesRead}=await handle.read(bytes,size,bytes.length-size,null);if(!bytesRead)break;size+=bytesRead;}
    if(size!==info.size)throw failure('migration_conflict');return parseStrict(bytes.subarray(0,size),{maxDepth:64});
  }
  finally{await handle.close();}
}
async function exists(file){try{await fsp.lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function atomic(file,value){
  await fsp.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID()+'.tmp';
  try{await fsp.writeFile(temp,json(value),{flag:'wx',mode:0o600});await fsp.rename(temp,file);}
  finally{await fsp.unlink(temp).catch(()=>{});}
}
async function copy(file,value){
  if(await exists(file)){if(digest(await read(file))!==digest(value))throw failure('migration_conflict');return;}
  await atomic(file,value);
}
function contains(folders,directory){return folders.some(folder=>{const relative=path.relative(folder,directory);return !relative || relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);});}
function createMigration({root,hooks={},clock=Date.now,retryMs=1000}){
  const store=new SessionStore(root),leases=new Map(),imports=new Map(),ready=new Set(),bridges=new Map(),statuses=new Map(),listeners=new Set(),pendingRegistrations=new Map();let syncing,closed=false,timer;
  const status=source=>statuses.get(source) || statuses.get(undefined) || {state:source?'pending':'ready'};
  function publish(source,value){if(json(statuses.get(source))===json(value))return;statuses.set(source,value);for(const listener of listeners)listener(source,value);}
  async function finish(source,sourceId,records){
    if(!bridges.has(source))bridges.set(source,await require('./mcp-bridge.cjs').serve({directory:path.join(source,'mcp'),call:()=>{
      throw Object.assign(Error('Replace the Rundix MCP entry with the service launcher and restart Claude MCP.'),{code:'adapter_upgrade_required'});
    }}));
    imports.set(sourceId,records);ready.add(source);publish(source,{state:'ready'});
  }
  async function importRoot(source){
    const canonicalSource=canonical(source),canonicalTarget=canonical(root);
    if(canonicalSource!==source || contains([source],canonicalTarget) || contains([canonicalTarget],source))throw failure('migration_conflict');
    const sourceId=createHash('sha256').update(process.platform+'\0'+source).digest('hex');
    const sourceStore=new SessionStore(path.join(source,'sessions-v1'));
    if(!leases.has(source)){try{leases.set(source,sourceStore.acquire('mcp-bridge'));}catch{throw failure('legacy_owner_active');}}
    const mcp=path.join(source,'mcp'),active=path.join(mcp,'tasks'),receipts=path.join(root,'migrations');
    const receiptFile=path.join(receipts,sourceId+'.json'),markerFile=path.join(mcp,'service-migration.json');
    const previous=await exists(receiptFile)?await read(receiptFile):null;
    const backupFor=g=>path.join(mcp,'backup-'+sourceId+(g?'-g'+g:''),'tasks');
    const targetFor=(g,id)=>path.join(root,'legacy',sourceId,...(g?['g'+g]:[]),'task-'+id+'.json');
    const generationOf=receipt=>receipt.generation || 0;
    const saved=[];
    async function verified(receipt){
      const generation=generationOf(receipt),manifest=receipt.manifest,backup=backupFor(generation);
      if(!Number.isSafeInteger(generation) || generation<0 || receipt.source!==source || manifest?.sourceId!==sourceId || !Array.isArray(manifest.records) || manifest.records.length>1000)throw failure('migration_conflict');
      const names=await exists(backup)?(await fsp.readdir(backup)).filter(name=>/^mcp-task-[\w-]+\.json$/.test(name)).sort():[];
      if(json(names)!==json(manifest.records.map(entry=>'mcp-task-'+entry.taskId+'.json').sort()))throw failure('migration_conflict');
      const records=[];
      for(const entry of manifest.records){
        if(!key(entry.taskId))throw failure('migration_conflict');
        const row=await read(targetFor(generation,entry.taskId));
        if(digest(row)!==entry.hash || row.sourceId!==sourceId || digest(await read(path.join(backup,'mcp-task-'+entry.taskId+'.json')))!==digest(row.task))throw failure('migration_conflict');
        records.push(describe(row,targetFor(generation,entry.taskId)));
      }
      return records;
    }
    // Older generations and targets are immutable. The primary receipt is only
    // replaced after the next generation has been copied and verified.
    const histories=await exists(receipts)?(await fsp.readdir(receipts)).filter(name=>name.startsWith(sourceId+'-g') && /^.+-g[0-9]+\.json$/.test(name)) : [];
    histories.sort((a,b)=>Number(a.match(/-g([0-9]+)\.json$/)[1])-Number(b.match(/-g([0-9]+)\.json$/)[1]));
    for(const file of histories){const receipt=await read(path.join(receipts,file));if(receipt.phase!=='cutover')throw failure('migration_conflict');saved.push(...await verified(receipt));}
    let generation=previous?generationOf(previous):0;
    if(previous?.phase==='cutover'){
      const marker=await read(markerFile);if(marker.manifestHash!==digest(previous.manifest))throw failure('migration_conflict');
      saved.push(...await verified(previous));
      if(!await exists(active)){await finish(source,sourceId,selected(saved));return;}
      await copy(path.join(receipts,sourceId+'-g'+generation+'.json'),previous);
      generation++;
    }else if(previous && previous.phase!=='verified')throw failure('migration_conflict');
    const backup=backupFor(generation);
    if(previous?.phase==='verified' && await exists(backup)){
      // Crash after rename: finish this generation before considering a newly
      // recreated active directory. Session changes cannot alter copied history.
      const rows=await verified(previous),marker=await read(markerFile);
      if(marker.manifestHash!==digest(previous.manifest))throw failure('migration_conflict');
      await atomic(receiptFile,{...previous,phase:'cutover'});saved.push(...rows);
      await finish(source,sourceId,selected(saved));return;
    }
    if(await exists(backup))throw failure('migration_conflict');
    const hasActive=await exists(active),names=hasActive?(await fsp.readdir(active)).filter(name=>/^mcp-task-[\w-]+\.json$/.test(name)).sort():[];
    if(names.length>1000)throw failure('migration_conflict');
    const records=[],checks=[],sessionLeases=[];
    const changed=()=>Object.assign(Error('Legacy source changed; retry later.'),{code:'legacy_source_changed'});
    try{
      for(const name of names){
        const sourceFile=path.join(active,name),task=await read(sourceFile);
        if(!key(task.taskId) || task.taskId!==name.slice(9,-5) || !key(task.sessionKey) || typeof task.projectDirectory!=='string' || task.projectDirectory.length>16384 || !path.isAbsolute(task.projectDirectory) || task.projectDirectory.includes('\0'))throw failure('migration_conflict');
        if(!['queued','running','waiting_approval','waiting_limit','completed','error','cancelled'].includes(task.state) || !Array.isArray(task.operations))throw failure('migration_conflict');
        let session=null;const sessionFile=sourceStore.file('session',task.sessionKey);
        if(await exists(sessionFile)){
          session=await read(sessionFile);
          if(session.key!==task.sessionKey || task.chatId && session.id!==task.chatId || !Array.isArray(session.items) || session.mcpTask!==true)throw failure('migration_conflict');
          if(session.id){if(!key(session.id))throw failure('migration_conflict');try{sessionLeases.push(sourceStore.acquire(session.id));}catch{throw failure('legacy_owner_active');}}
        }else if(task.chatId)throw failure('migration_conflict');
        let inferred=null,directory=path.normalize(task.projectDirectory);if(process.platform==='win32')directory=directory.toLowerCase();
        try{inferred=resolveSpace(directory).spaceId;directory=canonical(directory);}catch{}
        const interrupted=['running','waiting_approval'].includes(task.state) || !!task.recoveryRequired || !!task.needsReconcile || session?.lastTurnStatus==='inProgress';
        const row={schemaVersion:1,sourceId,taskId:'legacy-'+sourceId+'-'+task.taskId,projectDirectory:directory,inferredSpace:inferred,task,session,...(interrupted?{interrupted:true}:{})};
        // Only this pending generation may be re-copied. Committed targets stay
        // immutable, including when a taskId reappears with newer source data.
        await atomic(targetFor(generation,task.taskId),row);
        records.push(describe(row,targetFor(generation,task.taskId)));checks.push({file:sourceFile,hash:digest(task)});if(session)checks.push({file:sessionFile,hash:digest(session)});
        await hooks.afterCopy?.(records.length);
      }
      const verifySource=async()=>{
        const current=hasActive?(await fsp.readdir(active)).filter(name=>/^mcp-task-[\w-]+\.json$/.test(name)).sort():[];
        if(json(current)!==json(names))throw changed();
        for(const check of checks)if(digest(await read(check.file))!==check.hash)throw changed();
      };
      await verifySource();
      for(const row of records)if(digest(await read(targetFor(generation,row.task.taskId)))!==row.recordHash)throw failure('migration_conflict');
      const manifest={schemaVersion:1,sourceId,source,records:records.map(row=>({taskId:row.task.taskId,hash:row.recordHash}))};
      const receipt={schemaVersion:1,source,generation,manifest,phase:'verified'};
      await atomic(receiptFile,receipt);await hooks.afterVerify?.();await verifySource();
      await atomic(markerFile,{schemaVersion:1,sourceId,generation,manifestHash:digest(manifest)});await hooks.afterMarker?.();await verifySource();
      if(hasActive){await fsp.mkdir(path.dirname(backup),{recursive:true,mode:0o700});await fsp.rename(active,backup);}
      await atomic(receiptFile,{...receipt,phase:'cutover'});
      await finish(source,sourceId,selected([...saved,...records]));
    }finally{for(const release of sessionLeases)release();}
  }
  function describe(row,file){
    const value=row.task,session=row.session?Object.fromEntries(Object.entries(row.session).filter(([name])=>!['updatedAt','revision'].includes(name))):null;
    const task={taskId:value.taskId,description:typeof value.description==='string'?value.description.slice(0,160):'',state:value.state,progress:typeof value.progress==='string'?value.progress.slice(0,2000):'',
      chatId:value.chatId || null,projectDirectory:row.projectDirectory,createdAt:Number.isFinite(value.createdAt)?value.createdAt:0,updatedAt:Number.isFinite(value.updatedAt)?value.updatedAt:0,closedAt:Number.isFinite(value.closedAt)?value.closedAt:null,
      report:projection.report(value.report),unsentInputCount:value.unsentInputs?.length || 0};
    return {sourceId:row.sourceId,taskId:row.taskId,projectDirectory:row.projectDirectory,inferredSpace:row.inferredSpace,interrupted:!!row.interrupted,task,file,
      recordHash:digest(row),contentHash:digest({task:value,session})};
  }
  function selected(records){
    const latest=new Map(),seen=new Set();
    for(const row of records){const identity=row.taskId+'\0'+row.contentHash;if(seen.has(identity))continue;seen.add(identity);latest.set(row.taskId,row);}
    return [...latest.values()];
  }
  async function sync({force=false}={}){
    if(closed)throw failure('migration_conflict');if(syncing)return syncing;
    syncing=(async()=>{
      for(const [identity,source] of pendingRegistrations)if(force || !(status(identity).retryAt>clock())){
        try{await registerRootAsync(root,source);pendingRegistrations.delete(identity);if(ready.has(identity))publish(identity,{state:'ready'});else statuses.delete(identity);}
        catch(error){if(error.code==='ENOENT'){pendingRegistrations.delete(identity);publish(identity,{state:'vanished'});continue;}const attempt=(status(identity).attempt || 0)+1;publish(identity,{state:['EPERM','EACCES','EBUSY','legacy_registry_busy'].includes(error.code)?'retry_later':'needs_repair',code:error.code==='legacy_registry_busy'?error.code:'migration_conflict',attempt,retryAt:clock()+Math.min(60000,retryMs*2**Math.min(attempt-1,6))});}
      }
      for(const source of ready){try{await fsp.lstat(source);if(await exists(path.join(source,'mcp','tasks')))ready.delete(source);}catch{ready.delete(source);}}
      const visited=new Set();
      for(;;){const pending=roots(store).filter(source=>!visited.has(source) && !ready.has(source) && (force || !(status(source).retryAt>clock())));if(!pending.length)return;
        for(const source of pending){visited.add(source);try{await importRoot(source);}catch(error){
          if((hooks.afterCopy || hooks.afterVerify || hooks.afterMarker) && !error.code)throw error;
          let missing=false;try{await fsp.lstat(source);}catch(check){missing=check.code==='ENOENT';}
          if(missing){
            try{const release=store.acquire('legacy-roots');try{store.write('legacy','roots',{schemaVersion:1,roots:roots(store).filter(value=>value!==source)});}finally{release();}
              bridges.get(source)?.dispose();bridges.delete(source);leases.get(source)?.();leases.delete(source);publish(source,{state:'vanished'});continue;
            }catch(drop){error=drop.code?drop:registryBusy();}
          }
          const attempt=(status(source).attempt || 0)+1;
          const busy=error.code==='legacy_owner_active',transient=['EPERM','EBUSY','EACCES','ENOENT','legacy_source_changed','legacy_registry_busy'].includes(error.code);
          publish(source,{state:busy?'busy':transient?'retry_later':'needs_repair',code:busy?'legacy_owner_active':transient?'legacy_retry_later':'migration_conflict',attempt,
            retryAt:clock()+Math.min(60000,retryMs*2**Math.min(attempt-1,6))});
        }}
      }
    })().catch(error=>{
      if((hooks.afterCopy || hooks.afterVerify || hooks.afterMarker) && !error.code)throw error;
      publish(undefined,{state:'needs_repair',code:'migration_conflict',retryAt:clock()+60000});
    }).finally(()=>{syncing=null;clearTimeout(timer);if(!closed){timer=setTimeout(()=>void sync().catch(()=>{}),retryMs);timer.unref?.();}});return syncing;
  }
  function assertReady(){if(closed || roots(store).some(source=>!ready.has(source)))throw failure('legacy_owner_active');}
  const all=()=>[...imports.values()].flat();
  function visible(spaceId,folders){return all().filter(row=>(row.inferredSpace || 'legacy:'+row.sourceId)===spaceId && contains(folders,row.projectDirectory));}
  function spaces(folders){return [...imports].filter(([,rows])=>rows.some(row=>!row.inferredSpace && contains(folders,row.projectDirectory))).map(([id])=>({spaceId:'legacy:'+id,kind:'legacy',root:'Legacy history'}));}
  async function chat(spaceId,id,folders,generation){
    const row=visible(spaceId,folders).find(row=>row.taskId===id);if(!row)throw failure('unknown_task');
    const saved=await read(row.file);if(digest(saved)!==row.recordHash)throw failure('migration_conflict');
    return {generation,schemaVersion:1,viewRevision:0,spaceId,taskId:id,owner:'legacy',readOnly:true,chatId:row.task.chatId || null,
      title:('MCP · '+row.task.description).slice(0,167),state:row.interrupted?'error':row.task.state,recoveryRequired:!!row.interrupted,progress:row.task.progress,closed:false,pendingRequests:[],
      ...projection.transcript(saved.session?.items || []),cursor:null};
  }
  return {sync,assertReady,spaces,visible,chat,status,onChanged(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    async register(source){
      if(typeof source!=='string' || !path.isAbsolute(source) || source.includes('\0'))throw failure('migration_conflict');
      let identity=path.normalize(source);if(process.platform==='win32')identity=identity.toLowerCase();
      try{identity=canonical(source);await registerRootAsync(root,identity);await sync();if(ready.has(identity))publish(identity,{state:'ready'});}
      catch(error){if(error.code!=='ENOENT')pendingRegistrations.set(identity,source);if(ready.has(identity))publish(identity,{state:'ready'});else publish(identity,{state:error.code==='ENOENT'?'vanished':['EPERM','EACCES','EBUSY','legacy_registry_busy'].includes(error.code)?'retry_later':'needs_repair',code:error.code==='legacy_registry_busy'?error.code:'migration_conflict',retryAt:clock()+retryMs});}
      return identity;
    },
    async close(){closed=true;clearTimeout(timer);await syncing?.catch(()=>{});for(const bridge of bridges.values())bridge.dispose();bridges.clear();for(const release of leases.values())release();leases.clear();listeners.clear();},
  };
}
function legacyBridgeRoot(root,file,options){
  const unavailable=()=>Object.assign(Error('Migrate this legacy storage from a trusted Rundix window, then replace the Rundix MCP entry and restart Claude MCP.'),{code:'service_upgrade_required'});
  try{
    if(typeof file!=='string' || !path.isAbsolute(file) || path.basename(file)!=='bridge.json' || path.basename(path.dirname(file))!=='mcp')throw unavailable();
    const source=canonical(path.dirname(path.dirname(file))),sourceId=createHash('sha256').update(process.platform+'\0'+source).digest('hex');
    const load=file=>{const info=fs.lstatSync(file);if(!info.isFile() || info.isSymbolicLink() || info.size>1024*1024)throw unavailable();return parseStrict(fs.readFileSync(file),{maxDepth:16});};
    const marker=load(path.join(source,'mcp','service-migration.json')),directory=path.join(root,'migrations');
    const names=fs.readdirSync(directory).filter(name=>name===sourceId+'.json' || new RegExp('^'+sourceId+'-g[0-9]+\\.json$').test(name));
    const receipts=names.map(name=>load(path.join(directory,name)));
    const valid=receipt=>receipt.schemaVersion===1 && receipt.source===source && receipt.manifest?.sourceId===sourceId && receipt.manifest?.source===source && Array.isArray(receipt.manifest.records) && ['verified','cutover'].includes(receipt.phase);
    if(marker.schemaVersion!==1 || marker.sourceId!==sourceId || !receipts.every(valid) || !receipts.some(receipt=>receipt.phase==='cutover') || !receipts.some(receipt=>marker.manifestHash===digest(receipt.manifest)))throw unavailable();
    registerRoot(root,source,options);return source;
  }catch(error){if(error.code==='legacy_registry_busy')throw error;throw unavailable();}
}
module.exports={createMigration,registerRoot,registerRootAsync,contains,legacyBridgeRoot};
