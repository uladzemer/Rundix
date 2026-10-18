const locale=require('../ui/i18n.js');
// Shared by extension hosts on this machine. Each session has its own atomic record.
const fs=require('node:fs'),path=require('node:path');const {randomUUID}=require('node:crypto');
class SessionStore {
 constructor(directory){this.directory=directory;fs.mkdirSync(directory,{recursive:true,mode:0o700});}
 file(kind,key){if(!/^[a-zA-Z0-9_-]{1,128}$/.test(key))throw Error('Invalid local record key');return path.join(this.directory,kind+'-'+key+'.json');}
 read(kind,key){try{return JSON.parse(fs.readFileSync(this.file(kind,key),'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}}
 write(kind,key,value){const target=this.file(kind,key),temp=target+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(value),{flag:'wx',mode:0o600});fs.renameSync(temp,target);}finally{try{fs.unlinkSync(temp);}catch{}}return value;}
 session(key){return this.read('session',key);}
 saveSession(session,baseline){const previous=this.session(session.key),latest=previous||{},change={};for(const [key,value]of Object.entries(session))if(!previous||!baseline||JSON.stringify(value)!==JSON.stringify(baseline[key]))change[key]=value;return this.write('session',session.key,{...latest,...change,updatedAt:Date.now(),revision:randomUUID()});}
 list(cwd){return fs.readdirSync(this.directory).filter(name=>/^session-[a-zA-Z0-9_-]+\.json$/.test(name)).map(name=>this.session(name.slice(8,-5))).filter(row=>row&&(!cwd||path.resolve(row.cwd||'')===path.resolve(cwd))).sort((a,b)=>b.updatedAt-a.updatedAt);}
 meta(id){return this.read('meta',id)||{};}
 updateMeta(id,change){return this.write('meta',id,{...this.meta(id),...change});}
 host(key){return this.read('host',key);}
 saveHost(host){return this.write('host',host.hostKey,host);}
 acquire(id){const target=this.file('lease',id),nonce=randomUUID();for(let attempt=0;attempt<2;attempt++){
  try{fs.writeFileSync(target,JSON.stringify({pid:process.pid,nonce}),{flag:'wx',mode:0o600});return ()=>{const lease=this.read('lease',id);if(lease?.nonce===nonce)try{fs.unlinkSync(target);}catch{}};}
  catch(error){if(error.code!=='EEXIST')throw error;const lease=this.read('lease',id);let alive=false;try{if(lease?.pid){process.kill(lease.pid,0);alive=true;}}catch(error){if(error.code!=='ESRCH')alive=true;}if(alive)throw Error(locale.t('Эта сессия уже выполняет задачу в другом окне. Дождитесь завершения или создайте ветку.'));try{fs.unlinkSync(target);}catch{}}
 }throw Error(locale.t('Не удалось получить доступ к локальной сессии.'));}
 assertNoActiveTurns(){
  for(const name of fs.readdirSync(this.directory).filter(name=>/^lease-.*\.json$/.test(name)&&name!=='lease-account-credentials.json'&&!name.startsWith('lease-queued-session-'))){
   const lease=this.read('lease',name.slice(6,-5));if(!lease?.pid)continue;
   let alive=true;try{process.kill(lease.pid,0);}catch(error){alive=error.code!=='ESRCH';}
   if(alive)throw Error(locale.t('Дождитесь завершения задач во всех окнах Rundix перед сменой аккаунта.'));
  }
 }
}
module.exports={SessionStore};
