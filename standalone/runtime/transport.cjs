const locale=require('../ui/i18n.js');
const {spawn}=require('node:child_process');const {EventEmitter}=require('node:events');const fs=require('node:fs');const path=require('node:path');
function findCli(configured='') {
 if(configured){if(!fs.existsSync(configured))throw Error(locale.t('Codex CLI не найден по указанному пути.'));return configured;}
 const candidates=[];
 for(const dir of (process.env.PATH||'').split(path.delimiter))candidates.push(path.join(dir,process.platform==='win32'?'codex.exe':'codex'));
 if(process.platform==='win32')candidates.push(path.join(process.env.APPDATA||'','npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-'+process.arch+'/vendor/'+(process.arch==='arm64'?'aarch64':'x86_64')+'-pc-windows-msvc/bin/codex.exe'));
 for(const file of candidates)if(fs.existsSync(file)&&fs.statSync(file).isFile())return file;
 throw Error(locale.t('Установите официальный Codex CLI (npm install -g @openai/codex) или задайте rundix.cliPath.'));
}
class AppServer extends EventEmitter {
 constructor({executable,spawnProcess=spawn,cwd,env=process.env,configArgs=[]}={}){super();this.executable=executable;this.spawnProcess=spawnProcess;this.cwd=cwd;this.env=env;this.configArgs=configArgs;this.pending=new Map();this.serverRequests=new Map();this.sequence=0;}
 async start(){
  if(this.starting)return this.starting;
  this.starting=(async()=>{
   this.child=this.spawnProcess(this.executable||findCli(),['app-server','--listen','stdio://',...this.configArgs],{cwd:this.cwd,env:this.env,windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});
   const child=this.child;let failed=false,reason='';
   const failure=error=>{if(this.child!==child||failed)return;failed=true;this.child=null;this.fail(error);child.kill();};
   let buffer='';this.child.stdout.setEncoding('utf8');
   this.child.stdout.on('data',chunk=>{if(this.child!==child)return;buffer+=chunk;if(buffer.length>32*1024*1024){failure(Error(locale.t('Слишком большой ответ CLI.')));return;}let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;try{this.receive(JSON.parse(line));}catch{this.emit('protocolError',locale.t('CLI прислал некорректный JSON.'));}}});
   // Only fixed diagnostic categories leave this process; never forward raw stderr.
   this.child.stderr.on('data',chunk=>{
    const text=String(chunk);
    if(/error (?:loading|parsing) config|failed to (?:load|parse).*config|invalid.*(?:config|toml)|toml parse error/i.test(text))reason=locale.t('Ошибка конфигурации Codex.');
    else if(/database is locked|database.*(?:malformed|corrupt)|sqlite.*(?:locked|corrupt)/i.test(text))reason=locale.t('Хранилище Codex заблокировано или повреждено.');
    else if(/permission denied|access is denied|os error 5\b/i.test(text))reason=locale.t('CLI не получил доступ к файлам.');
   });
   this.child.stdin.on('error',()=>failure(Error(locale.t('Соединение с Codex CLI прервано. Нажмите «Переподключиться».'))));
   this.child.on('error',error=>failure(Error(error.code==='ENOENT'?locale.t('Codex CLI не найден по указанному пути.'):locale.t('Не удалось запустить Codex CLI. Проверьте путь и права доступа.'))));
   this.child.on('close',(code,signal)=>failure(Error(locale.t('Codex CLI завершился ({0}). Нажмите «Переподключиться».',code??signal??'signal')+(reason?' '+reason:''))));
   const result=await this.request('initialize',{clientInfo:{name:'rundix_local',title:'Rundix',version:require('../package.json').version},capabilities:{experimentalApi:true}});
   this.write({method:'initialized',params:{}});return result;
  })();return this.starting;
 }
 write(message){if(!this.child?.stdin.writable)throw Error(locale.t('Codex CLI не подключён.'));this.child.stdin.write(JSON.stringify(message)+'\n');}
 request(method,params={},timeout=30000){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Object.assign(Error(locale.t("Нет ответа Codex: {0}",method)),{deliveryUncertain:true}));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.write({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(Object.assign(error,{deliveryUncertain:false}));}});}
 receive(message){
  if(message.method){if(message.id!==undefined){this.serverRequests.set(String(message.id),message);this.emit('request',message);}else this.emit('notification',message);return;}
  const entry=this.pending.get(message.id);if(!entry)return;this.pending.delete(message.id);clearTimeout(entry.timer);if(message.error)entry.reject(Object.assign(Error(message.error.message),{deliveryUncertain:false}));else entry.resolve(message.result);
 }
 respond(id,result,error){if(!this.serverRequests.has(String(id)))return false;this.write(error?{id,error}:{id,result});this.serverRequests.delete(String(id));return true;}
 fail(error){for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(Object.assign(Error(error.message),{deliveryUncertain:true}));}this.pending.clear();this.serverRequests.clear();this.starting=null;this.emit('disconnected',error.message);}
 dispose(){const child=this.child;this.child=null;this.removeAllListeners();this.fail(Error(locale.t('Клиент закрыт.')));child?.kill();}
}
module.exports={AppServer,findCli};
