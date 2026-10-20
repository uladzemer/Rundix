const locale=require('../ui/i18n.js');
// Shared by extension hosts on this machine. Each session has its own atomic record.
const fs=require('node:fs'),path=require('node:path');const {randomUUID}=require('node:crypto');
const unreadableGraceMs=60000,recordLockTimeoutMs=2000;
const pause=new Int32Array(new SharedArrayBuffer(4));
function lockValue(target){try{return JSON.parse(fs.readFileSync(target,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}}
function staleLock(target){
 const owner=lockValue(target);
 if(Number.isSafeInteger(owner?.pid)&&owner.pid>0){try{process.kill(owner.pid,0);return false;}catch(error){return error.code==='ESRCH';}}
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
function tryLock(target){
 const nonce=randomUUID(),temp=target+'.'+nonce+'.tmp';
 try{
  // Linking a fully written file publishes the owner atomically without replacing a winner.
  fs.writeFileSync(temp,JSON.stringify({pid:process.pid,nonce}),{flag:'wx',mode:0o600});
  for(let attempt=0;attempt<2;attempt++){
   try{fs.linkSync(temp,target);return ()=>{if(lockValue(target)?.nonce===nonce)try{fs.unlinkSync(target);}catch(error){if(error.code!=='ENOENT')throw error;}};}
   catch(error){if(error.code!=='EEXIST')throw error;}
   // Serialize stale removal and re-read under the guard: another reaper may
   // already have replaced the dead lease with a live owner.
   if(!staleLock(target)&&fs.existsSync(target))return null;
   const releaseGuard=reapGuard(target+'.reap');if(!releaseGuard)return null;
   try{if(!staleLock(target)&&fs.existsSync(target))return null;try{fs.unlinkSync(target);}catch(error){if(error.code!=='ENOENT')throw error;}}
   finally{releaseGuard();}
  }
  return null;
 }finally{try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
function withRecordLock(target,operation){
 const deadline=Date.now()+recordLockTimeoutMs;
 for(;;){const release=tryLock(target);if(release){try{return operation();}finally{release();}}if(Date.now()>=deadline)throw Error('Local record is busy; retry saving.');Atomics.wait(pause,0,0,10);}
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
 acquire(id){const release=tryLock(this.file('lease',id));if(release)return release;throw Error(locale.t('Эта сессия уже выполняет задачу в другом окне. Дождитесь завершения или создайте ветку.'));}
 assertNoActiveTurns(){
  for(const name of fs.readdirSync(this.directory).filter(name=>/^lease-.*\.json$/.test(name)&&name!=='lease-account-credentials.json'&&name!=='lease-mcp-bridge.json'&&!name.startsWith('lease-directory-')&&!name.startsWith('lease-queued-session-'))){
   const lease=this.read('lease',name.slice(6,-5));if(!lease?.pid)continue;
   let alive=true;try{process.kill(lease.pid,0);}catch(error){alive=error.code!=='ESRCH';}
   if(alive)throw Error(locale.t('Дождитесь завершения задач во всех окнах Rundix перед сменой аккаунта.'));
  }
 }
}
module.exports={SessionStore};
