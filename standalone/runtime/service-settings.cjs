const fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {parseStrict}=require('./service-json.cjs');
const {boundedRead}=require('./service-provider-config.cjs');
function readSettings(root) {
  let value;
  try { value = parseStrict(boundedRead(path.join(root, 'settings.json'), 65536)); }
  catch (error) { if (error.code === 'ENOENT') value = {}; else throw Object.assign(Error('Service settings are unavailable.'), {code:'storage_unavailable'}); }
  const allowed = ['mcpAccessMode', 'mcpMaxParallelTasks', 'mcpThreadConfig', 'cliPath'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) ||
      (value.mcpAccessMode !== undefined && !['manual', 'workspace', 'auto', 'full'].includes(value.mcpAccessMode)) ||
      (value.mcpMaxParallelTasks !== undefined && (!Number.isInteger(value.mcpMaxParallelTasks) || value.mcpMaxParallelTasks < 1 || value.mcpMaxParallelTasks > 5)) ||
      (value.cliPath !== undefined && (typeof value.cliPath !== 'string' || !path.isAbsolute(value.cliPath))) ||
      (value.mcpThreadConfig !== undefined && (!value.mcpThreadConfig || typeof value.mcpThreadConfig !== 'object' || Array.isArray(value.mcpThreadConfig))))
    throw Object.assign(Error('Service settings are invalid.'), {code:'storage_unavailable'});
  return value;
}
function plainSettings(root) {readSettings(root);return (key,fallback)=>readSettings(root)[key] ?? fallback;}

const KEYS=['mcpAccessMode','mcpThreadConfig','mcpMaxParallelTasks','cliPath'];
async function writeServiceSettings(root, inspect) {
  const value=Object.fromEntries(KEYS.map(key=>[key,inspect(key)?.globalValue]).filter(([key,v])=>v!==undefined && !(key==='cliPath' && v==='')));
  const {Worker}=require('node:worker_threads');
  return new Promise((resolve,reject)=>{
    const worker=new Worker(__filename,{workerData:{settingsWrite:{root,value}}});
    const timer=setTimeout(()=>{worker.terminate();reject(Error('Service settings write timed out.'));},15000);
    worker.once('message',message=>{clearTimeout(timer);message.ok?resolve():reject(Error('Service settings write failed.'));});
    worker.once('error',()=>{clearTimeout(timer);reject(Error('Service settings write failed.'));});
    worker.once('exit',code=>{if(code){clearTimeout(timer);reject(Error('Service settings write failed.'));}});
  });
}
async function writeValue(root,value) {
  require('./service-endpoint.cjs').protectDirectory(root);
  const bytes=JSON.stringify(value);
  if(Buffer.byteLength(bytes)>65536)throw Error('Service settings are too large.');
  const file=path.join(root,'settings.json'),temp=file+'.'+randomUUID()+'.tmp';
  try {await fs.promises.writeFile(temp,bytes,{flag:'wx',mode:0o600});await fs.promises.rename(temp,file);}
  finally {await fs.promises.unlink(temp).catch(()=>{});}
}
module.exports={plainSettings,writeServiceSettings,KEYS};
const {isMainThread,workerData,parentPort}=require('node:worker_threads');
if(!isMainThread && workerData?.settingsWrite) {
  writeValue(workerData.settingsWrite.root,workerData.settingsWrite.value).then(()=>parentPort.postMessage({ok:true}),()=>parentPort.postMessage({ok:false}));
}
