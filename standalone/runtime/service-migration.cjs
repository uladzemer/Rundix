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
function registerRoot(root,source){
  source=canonical(source);const target=canonical(root);
  if(contains([source],target) || contains([target],source))throw failure('migration_conflict');
  const store=new SessionStore(root),release=store.acquire('legacy-roots');
  try{const list=roots(store);if(!list.includes(source)){if(list.length>=100)throw failure('migration_conflict');store.write('legacy','roots',{schemaVersion:1,roots:[...list,source]});}}
  finally{release();}
  return source;
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
function createMigration({root,hooks={}}){
  const store=new SessionStore(root),leases=new Map(),imports=new Map(),ready=new Set(),bridges=new Map();let syncing,closed=false;
  async function finish(source,sourceId,records){
    if(!bridges.has(source))bridges.set(source,await require('./mcp-bridge.cjs').serve({directory:path.join(source,'mcp'),call:()=>{
      throw Object.assign(Error('Replace the Rundix MCP entry with the service launcher and restart Claude MCP.'),{code:'adapter_upgrade_required'});
    }}));
    imports.set(sourceId,records);ready.add(source);
  }
  async function importRoot(source){
    const canonicalSource=canonical(source),canonicalTarget=canonical(root);
    if(canonicalSource!==source || contains([source],canonicalTarget) || contains([canonicalTarget],source))throw failure('migration_conflict');
    const sourceId=createHash('sha256').update(process.platform+'\0'+source).digest('hex');
    const sourceStore=new SessionStore(path.join(source,'sessions-v1'));
    if(!leases.has(source)){try{leases.set(source,sourceStore.acquire('mcp-bridge'));}catch{throw failure('legacy_owner_active');}}
    const mcp=path.join(source,'mcp'),active=path.join(mcp,'tasks'),backup=path.join(mcp,'backup-'+sourceId,'tasks');
    const hasActive=await exists(active),hasBackup=await exists(backup);
    if(hasActive && hasBackup)throw failure('migration_conflict');
    const tasksDirectory=hasActive?active:hasBackup?backup:null;
    const receiptFile=path.join(root,'migrations',sourceId+'.json'),markerFile=path.join(mcp,'service-migration.json');
    const previous=await exists(receiptFile)?await read(receiptFile):null;
    if(previous?.phase==='cutover'){
      if(hasActive || previous.source!==source || previous.manifest?.sourceId!==sourceId || !Array.isArray(previous.manifest?.records))throw failure('migration_conflict');
      const marker=await read(markerFile);if(marker.manifestHash!==digest(previous.manifest))throw failure('migration_conflict');
      const actual=hasBackup?(await fsp.readdir(backup)).filter(name=>/^mcp-task-[\w-]+\.json$/.test(name)).sort():[];
      if(json(actual)!==json(previous.manifest.records.map(entry=>'mcp-task-'+entry.taskId+'.json').sort()))throw failure('migration_conflict');
      const saved=[];
      for(const entry of previous.manifest.records){
        if(!key(entry.taskId))throw failure('migration_conflict');
        const row=await read(path.join(root,'legacy',sourceId,'task-'+entry.taskId+'.json'));
        if(digest(row)!==entry.hash || row.sourceId!==sourceId || digest(await read(path.join(backup,'mcp-task-'+entry.taskId+'.json')))!==digest(row.task))throw failure('migration_conflict');
        saved.push(row);
      }
      await finish(source,sourceId,saved);return;
    }
    const names=tasksDirectory?(await fsp.readdir(tasksDirectory)).filter(name=>/^mcp-task-[\w-]+\.json$/.test(name)).sort():[];
    if(names.length>1000)throw failure('migration_conflict');
    const records=[],checks=[],sessionLeases=[];
    try{
      for(const name of names){
        const sourceFile=path.join(tasksDirectory,name),task=await read(sourceFile);
        if(!key(task.taskId) || task.taskId!==name.slice(9,-5) || !key(task.sessionKey) || typeof task.projectDirectory!=='string' || !path.isAbsolute(task.projectDirectory) || task.projectDirectory.includes('\0'))throw failure('migration_conflict');
        if(!['queued','running','waiting_approval','waiting_limit','completed','error','cancelled'].includes(task.state) || !Array.isArray(task.operations))throw failure('migration_conflict');
        if(['running','waiting_approval'].includes(task.state) || task.recoveryRequired || task.needsReconcile)throw failure('legacy_owner_active');
        let session=null;const sessionFile=sourceStore.file('session',task.sessionKey);
        if(await exists(sessionFile)){
          session=await read(sessionFile);
          if(session.key!==task.sessionKey || task.chatId && session.id!==task.chatId || !Array.isArray(session.items) || session.mcpTask!==true)throw failure('migration_conflict');
          if(session.lastTurnStatus==='inProgress')throw failure('legacy_owner_active');
          if(session.id){if(!key(session.id))throw failure('migration_conflict');try{sessionLeases.push(sourceStore.acquire(session.id));}catch{throw failure('legacy_owner_active');}}
        }else if(task.chatId)throw failure('migration_conflict');
        let inferred=null,directory=path.normalize(task.projectDirectory);if(process.platform==='win32')directory=directory.toLowerCase();
        try{inferred=resolveSpace(directory).spaceId;directory=canonical(directory);}catch{}
        const row={schemaVersion:1,sourceId,taskId:'legacy-'+sourceId+'-'+task.taskId,projectDirectory:directory,inferredSpace:inferred,task,session};
        const target=path.join(root,'legacy',sourceId,'task-'+task.taskId+'.json');await copy(target,row);
        records.push(row);checks.push({file:sourceFile,hash:digest(task)});if(session)checks.push({file:sessionFile,hash:digest(session)});
        await hooks.afterCopy?.(records.length);
      }
      // Re-read both source and target under the bridge/thread leases before marking.
      for(const check of checks)if(digest(await read(check.file))!==check.hash)throw failure('migration_conflict');
      const verifyNames=async()=>{const current=tasksDirectory?(await fsp.readdir(tasksDirectory)).filter(name=>/^mcp-task-[\w-]+\.json$/.test(name)).sort():[];if(json(current)!==json(names))throw failure('migration_conflict');};
      await verifyNames();
      for(const row of records){const file=path.join(root,'legacy',sourceId,'task-'+row.task.taskId+'.json');if(digest(await read(file))!==digest(row))throw failure('migration_conflict');}
      const manifest={schemaVersion:1,sourceId,source,records:records.map(row=>({taskId:row.task.taskId,hash:digest(row)}))};
      if(previous && (previous.source!==source || !previous.manifest || digest(previous.manifest)!==digest(manifest)))throw failure('migration_conflict');
      if(previous && !tasksDirectory && previous.manifest.records.length)throw failure('migration_conflict');
      const marker={schemaVersion:1,sourceId,manifestHash:digest(manifest)};
      if(await exists(markerFile)){if(digest(await read(markerFile))!==digest(marker))throw failure('migration_conflict');}
      await atomic(receiptFile,{schemaVersion:1,source,manifest,phase:'verified'});await hooks.afterVerify?.();
      await verifyNames();for(const check of checks)if(digest(await read(check.file))!==check.hash)throw failure('migration_conflict');
      await atomic(markerFile,marker);await hooks.afterMarker?.();
      await verifyNames();for(const check of checks)if(digest(await read(check.file))!==check.hash)throw failure('migration_conflict');
      if(hasActive){await fsp.mkdir(path.dirname(backup),{recursive:true,mode:0o700});await fsp.rename(active,backup);}
      await atomic(receiptFile,{schemaVersion:1,source,manifest,phase:'cutover'});
      await finish(source,sourceId,records);
    }finally{for(const release of sessionLeases)release();}
  }
  async function sync(){
    if(closed)throw failure('migration_conflict');if(syncing)return syncing;
    syncing=(async()=>{for(;;){const pending=roots(store).filter(source=>!ready.has(source));if(!pending.length)return;for(const source of pending)await importRoot(source);}})().catch(error=>{
      if(['legacy_owner_active','migration_conflict'].includes(error.code))throw error;
      if(hooks.afterCopy || hooks.afterVerify || hooks.afterMarker)throw error;
      throw failure('migration_conflict');
    }).finally(()=>{syncing=null;});return syncing;
  }
  function assertReady(){if(closed || roots(store).some(source=>!ready.has(source)))throw failure('legacy_owner_active');}
  const all=()=>[...imports.values()].flat();
  function visible(spaceId,folders){return all().filter(row=>(row.inferredSpace || 'legacy:'+row.sourceId)===spaceId && contains(folders,row.projectDirectory));}
  function spaces(folders){return [...imports].filter(([,rows])=>rows.some(row=>!row.inferredSpace && contains(folders,row.projectDirectory))).map(([id])=>({spaceId:'legacy:'+id,kind:'legacy',root:'Legacy history'}));}
  function chat(spaceId,id,folders,generation){
    const row=visible(spaceId,folders).find(row=>row.taskId===id);if(!row)throw failure('unknown_task');
    return {generation,schemaVersion:1,viewRevision:0,spaceId,taskId:id,owner:'legacy',readOnly:true,chatId:row.task.chatId || null,
      title:('MCP · '+row.task.description).slice(0,167),state:row.task.state,progress:row.task.progress,closed:false,pendingRequests:[],
      ...projection.transcript(row.session?.items || []),cursor:null};
  }
  return {sync,assertReady,spaces,visible,chat,
    async register(source){source=registerRoot(root,source);while(!ready.has(source))await sync();},
    async close(){closed=true;await syncing?.catch(()=>{});for(const bridge of bridges.values())bridge.dispose();bridges.clear();for(const release of leases.values())release();leases.clear();},
  };
}
function legacyBridgeRoot(root,file){
  const unavailable=()=>Object.assign(Error('Migrate this legacy storage from a trusted Rundix window, then replace the Rundix MCP entry and restart Claude MCP.'),{code:'service_upgrade_required'});
  try{
    if(typeof file!=='string' || !path.isAbsolute(file) || path.basename(file)!=='bridge.json' || path.basename(path.dirname(file))!=='mcp')throw unavailable();
    const source=canonical(path.dirname(path.dirname(file))),sourceId=createHash('sha256').update(process.platform+'\0'+source).digest('hex');
    const load=file=>{const info=fs.lstatSync(file);if(!info.isFile() || info.isSymbolicLink() || info.size>1024*1024)throw unavailable();return parseStrict(fs.readFileSync(file),{maxDepth:16});};
    const marker=load(path.join(source,'mcp','service-migration.json')),receipt=load(path.join(root,'migrations',sourceId+'.json'));
    if(marker.schemaVersion!==1 || marker.sourceId!==sourceId || receipt.phase!=='cutover' || receipt.source!==source || marker.manifestHash!==digest(receipt.manifest))throw unavailable();
    registerRoot(root,source);return source;
  }catch{throw unavailable();}
}
module.exports={createMigration,registerRoot,contains,legacyBridgeRoot};
