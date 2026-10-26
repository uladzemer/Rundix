const locale=require('../ui/i18n.js');
// Shared by extension hosts on this machine. Each session has its own atomic record.
const fs=require('node:fs'),path=require('node:path');const {randomUUID}=require('node:crypto');
const reuseSlackMs=30000,reuseMinAgeMs=10000,reuseCacheMax=64,unreadableGraceMs=60000,recordLockTimeoutMs=2000,recordLockMaxAgeMs=10000;
const pause=new Int32Array(new SharedArrayBuffer(4));
function lockValue(target){try{return JSON.parse(fs.readFileSync(target,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}}
function staleLock(target,maxAgeMs){
 try{return staleCheck(target,maxAgeMs);}catch{return false;}
}
// A live-looking (or EPERM) pid whose process started after the lease was written belongs to someone else.
// Unreadable creation time keeps the lease held. Leases younger than reuseMinAgeMs skip the (slow) query.
// The slack tolerates clock skew between the lease writer and the process start clock. A contended acquire
// loop must not spawn a query per retry, so results are cached per (pid, lease mtime). Only "reused" is final:
// a live owner can die and its pid be reused later, and an unreadable start time can be transient, so those
// results expire after reuseRecheckMs.
const reuseStarts=new Map(),reuseRecheckMs=30000;
function reusedPid(pid,target){
 if(pid===process.pid)return false;
 try{
  const mtime=fs.statSync(target).mtimeMs;
  if(Date.now()-mtime<reuseMinAgeMs)return false;
  const key=pid+':'+mtime,cached=reuseStarts.get(key);
  if(cached&&(cached.reused||Date.now()-cached.at<reuseRecheckMs))return cached.reused;
  const service=require('./service-process.cjs'),started=service.startedAtMs(service.processIdentity(pid));
  const reused=started!==null&&started>mtime+reuseSlackMs;
  reuseStarts.delete(key);
  if(reuseStarts.size>=reuseCacheMax)reuseStarts.delete(reuseStarts.keys().next().value);
  reuseStarts.set(key,{reused,at:Date.now()});
  return reused;
 }catch{return false;}
}
function staleCheck(target,maxAgeMs){
 // Record locks live for milliseconds, so an old one is stale even if its pid was reused or its owner hung.
 if(maxAgeMs){try{if(Date.now()-fs.statSync(target).mtimeMs>maxAgeMs)return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
 const owner=lockValue(target);
 if(Number.isSafeInteger(owner?.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')return true;}return reusedPid(owner.pid,target);}
 try{return Date.now()-fs.statSync(target).mtimeMs>unreadableGraceMs;}catch(error){if(error.code==='ENOENT')return false;throw error;}
}
function reapGuard(target){
 // Publish a nonempty directory. Removing a dead owner's unique child followed
 // by rmdir cannot remove a replacement guard: its different child keeps it nonempty.
 const owner=process.pid+'-'+randomUUID(),temp=target+'.'+owner+'.tmp';
 fs.mkdirSync(temp,{mode:0o700});
 try{
  fs.writeFileSync(path.join(temp,owner),'',{flag:'wx',mode:0o600});
  for(let attempt=0;attempt<2;attempt++){
   try{fs.renameSync(temp,target);return ()=>removeGuardOwner(target,owner);}
   catch(error){if(!['EEXIST','ENOTEMPTY','EPERM','EACCES'].includes(error.code)||!fs.existsSync(target))throw error;}
   let entries;try{entries=fs.readdirSync(target);}catch(error){if(error.code==='ENOENT')continue;throw error;}
   if(entries.length>1)return null;
   if(entries.length){const match=/^([1-9][0-9]*)-[a-f0-9-]{36}$/.exec(entries[0]);if(!match)return null;
    try{process.kill(Number(match[1]),0);return null;}catch(error){if(error.code!=='ESRCH')return null;}
   }
   removeGuardOwner(target,entries[0]);
  }
  return null;
 }finally{removeGuardOwner(temp,owner);}
}
function removeGuardOwner(target,owner){
 if(owner)try{fs.unlinkSync(path.join(target,owner));}catch(error){if(error.code!=='ENOENT')throw error;}
 try{fs.rmdirSync(target);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;}
}
// Best-effort file removal: antivirus or indexers can briefly hold handles on Windows; that must
// neither mask a lock that was acquired nor leave the caller without its release function.
function removeQuietly(file,attempts=1){
 for(let attempt=0;attempt<attempts;attempt++){
  try{fs.unlinkSync(file);return;}catch(error){if(error.code==='ENOENT')return;if(attempt+1<attempts)Atomics.wait(pause,0,0,25);}
 }
}
function publish(temp,target,content){
 try{fs.linkSync(temp,target);return true;}
 catch(error){
  if(error.code==='EEXIST')return false;
  // Volumes without hard links (FAT/exFAT, some network shares): exclusive create still works;
  // a reader seeing a partially written file treats it as live until the grace period.
  if(['EPERM','ENOSYS','ENOTSUP','EXDEV','EINVAL','UNKNOWN','EACCES'].includes(error.code)){
   try{fs.writeFileSync(target,content,{flag:'wx',mode:0o600});return true;}
   catch(fallback){if(['EEXIST','EPERM','EACCES','EBUSY'].includes(fallback.code))return false;throw fallback;}
  }
  throw error;
 }
}
function tryLock(target,maxAgeMs){
 const nonce=randomUUID(),temp=target+'.'+nonce+'.tmp',content=JSON.stringify({pid:process.pid,nonce});
 try{
  // Linking a fully written file publishes the owner atomically without replacing a winner.
  fs.writeFileSync(temp,content,{flag:'wx',mode:0o600});
  for(let attempt=0;attempt<2;attempt++){
   // Releasing retries briefly: a lock left behind by a transient handle would block its live owner's next acquire.
   if(publish(temp,target,content))return ()=>{let owner=null;try{owner=lockValue(target);}catch{}if(owner?.nonce===nonce)removeQuietly(target,5);};
   // Serialize stale removal and re-read under the guard: another reaper may
   // already have replaced the dead lease with a live owner.
   if(!staleLock(target,maxAgeMs)&&fs.existsSync(target))return null;
   const releaseGuard=reapGuard(target+'.reap');if(!releaseGuard)return null;
   try{if(!staleLock(target,maxAgeMs)&&fs.existsSync(target))return null;removeQuietly(target);}
   finally{try{releaseGuard();}catch{}}
  }
  return null;
 }finally{removeQuietly(temp);}
}
function withRecordLock(target,operation){
 const deadline=Date.now()+recordLockTimeoutMs;
 for(;;){const release=tryLock(target,recordLockMaxAgeMs);if(release){try{return operation();}finally{release();}}if(Date.now()>=deadline)throw Error('Local record is busy; retry saving.');Atomics.wait(pause,0,0,10);}
}
class SessionStore {
 constructor(directory){this.directory=directory;fs.mkdirSync(directory,{recursive:true,mode:0o700});}
 file(kind,key){if(!/^[a-zA-Z0-9_-]{1,128}$/.test(key))throw Error('Invalid local record key');return path.join(this.directory,kind+'-'+key+'.json');}
 read(kind,key){try{return JSON.parse(fs.readFileSync(this.file(kind,key),'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}}
 write(kind,key,value){const target=this.file(kind,key),temp=target+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(value),{flag:'wx',mode:0o600});fs.renameSync(temp,target);}finally{try{fs.unlinkSync(temp);}catch{}}return value;}
 session(key){return this.read('session',key);}
 saveSession(session,baseline){return withRecordLock(this.file('record-session',session.key),()=>{const previous=this.session(session.key),latest=previous||{},change={};for(const [key,value]of Object.entries(session))if(!previous||!baseline||JSON.stringify(value)!==JSON.stringify(baseline[key]))change[key]=value;return this.write('session',session.key,{...latest,...change,updatedAt:Date.now(),revision:randomUUID()});});}
 list(cwd){return fs.readdirSync(this.directory).filter(name=>/^session-[a-zA-Z0-9_-]+\.json$/.test(name)).map(name=>this.session(name.slice(8,-5))).filter(row=>row&&(!cwd||path.resolve(row.cwd||'')===path.resolve(cwd))).sort((a,b)=>b.updatedAt-a.updatedAt);}
 meta(id){return this.read('meta',id)||{};}
 updateMeta(id,change){return withRecordLock(this.file('record-meta',id),()=>this.write('meta',id,{...this.meta(id),...change}));}
 host(key){return this.read('host',key);}
 saveHost(host){return this.write('host',host.hostKey,host);}
 acquire(id){const release=tryLock(this.file('lease',id));if(release)return release;throw Object.assign(Error(locale.t('Эта сессия уже выполняет задачу в другом окне. Дождитесь завершения или создайте ветку.')),{code:'SESSION_BUSY'});}
 assertNoActiveTurns(){
  for(const name of fs.readdirSync(this.directory).filter(name=>/^lease-.*\.json$/.test(name)&&name!=='lease-account-credentials.json'&&name!=='lease-mcp-bridge.json'&&!name.startsWith('lease-directory-')&&!name.startsWith('lease-queued-session-'))){
   const lease=this.read('lease',name.slice(6,-5));if(!lease?.pid)continue;
   let alive=true;try{process.kill(lease.pid,0);}catch(error){alive=error.code!=='ESRCH';}
   if(alive&&reusedPid(lease.pid,this.file('lease',name.slice(6,-5))))alive=false;
   if(alive)throw Error(locale.t('Дождитесь завершения задач во всех окнах Rundix перед сменой аккаунта.'));
  }
 }
}
module.exports={SessionStore};
