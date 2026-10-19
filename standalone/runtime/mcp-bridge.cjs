const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {randomBytes, timingSafeEqual} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const MAX = 1024 * 1024;
function privateDirectory(directory) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if (process.platform === 'win32') {
    const sid=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{encoding:'utf8',windowsHide:true,timeout:10000}).trim();
    if (!/^S-1-[\d-]+$/.test(sid)) throw Error('Cannot protect MCP storage.');
    execFileSync('icacls.exe',[directory,'/inheritance:r','/grant:r','*'+sid+':(OI)(CI)F','*S-1-5-18:(OI)(CI)F'],{windowsHide:true,timeout:10000,stdio:'pipe'});
  } else fs.chmodSync(directory,0o700);
}
async function serve({directory, call}) {
  privateDirectory(directory);
  const secret=randomBytes(32).toString('hex');
  const server=http.createServer((req,res)=>{
    const supplied=Buffer.from(req.headers.authorization || ''), expected=Buffer.from('Bearer '+secret);
    if (req.method!=='POST' || req.url!=='/call' || supplied.length!==expected.length || !timingSafeEqual(supplied,expected) || req.headers.origin) {
      res.writeHead(403); res.end(); return;
    }
    let body='', size=0;
    req.on('data',chunk=>{size+=chunk.length;if(size>MAX){req.destroy();return;}body+=chunk;});
    req.on('end',async()=>{
      try {const message=JSON.parse(body);const result=await call(message.name,message.arguments);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result}));}
      catch {res.statusCode=400;res.end(JSON.stringify({error:'Request rejected. Check arguments, task state, connection and workspace trust.'}));}
    });
    req.on('error',()=>{});
  });
  server.requestTimeout=10000; server.headersTimeout=10000; server.timeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const descriptor=path.join(directory,'bridge.json');
  try {fs.writeFileSync(descriptor,JSON.stringify({version:1,port:server.address().port,secret}),{mode:0o600});}
  catch(error){server.close();throw error;}
  return {descriptor,dispose(){server.closeAllConnections();server.close();try{fs.unlinkSync(descriptor);}catch{}}};
}
function request(descriptor, name, args) {
  return new Promise((resolve,reject)=>{
    let config;
    try {config=JSON.parse(fs.readFileSync(descriptor,'utf8'));if(config.version!==1 || !Number.isInteger(config.port) || config.port<1 || config.port>65535 || !/^[a-f0-9]{64}$/.test(config.secret))throw Error();}
    catch {reject(Error('MCP bridge is unavailable. Open VS Code and start the Rundix MCP bridge.'));return;}
    const body=JSON.stringify({name,arguments:args});
    const req=http.request({hostname:'127.0.0.1',port:config.port,path:'/call',method:'POST',headers:{Authorization:'Bearer '+config.secret,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      let output='',size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>MAX){res.destroy();reject(Error('MCP response too large.'));return;}output+=chunk;});
      res.on('error',()=>reject(Error('MCP bridge connection failed.')));
      res.on('end',()=>{try{const parsed=JSON.parse(output);if(res.statusCode!==200 || parsed.error)throw Error(parsed.error || 'Bridge request failed.');resolve(parsed.result);}catch(error){reject(error);}});
    });
    req.setTimeout(12000,()=>req.destroy());req.on('error',()=>reject(Error('MCP bridge unavailable or request timed out. Retry mutations with the same requestId.')));req.end(body);
  });
}
module.exports={serve,request,privateDirectory};
