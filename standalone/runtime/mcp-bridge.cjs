const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {randomBytes, timingSafeEqual} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const MAX = 1024 * 1024;
const UNAVAILABLE = 'Rundix MCP bridge is not running. In VS Code run "Rundix: Start MCP bridge and show Claude configuration" or press Start in the Rundix MCP panel, then retry; reuse the same requestId for mutations.';
// Long polls keep the socket open for their wait budget plus a margin for the final snapshot.
function budget(name, args) {
  if (name !== 'wait_task') return 12000;
  const seconds = Number.isInteger(args?.waitSeconds) ? Math.min(Math.max(args.waitSeconds, 1), 1500) : 600;
  return seconds * 1000 + 15000;
}
function bridgeError(message, code) { return Object.assign(Error(message), {code}); }
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
      let message;
      try {message=JSON.parse(body);}catch{res.statusCode=400;res.end(JSON.stringify({error:'Invalid bridge request.',code:'invalid_request'}));return;}
      req.socket.setTimeout(budget(message?.name,message?.arguments));
      try {const result=await call(message.name,message.arguments);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result}));}
      catch(error) {
        // Only coded errors carry client-safe text; anything unexpected stays generic.
        const coded=typeof error?.code==='string' && /^[a-z_]{1,40}$/.test(error.code) && typeof error.message==='string';
        res.statusCode=400;res.end(JSON.stringify(coded?{error:error.message.slice(0,500),code:error.code}:{error:'Request rejected. Check arguments, task state, connection and workspace trust in the Rundix MCP panel.',code:'rejected'}));
      }
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
    catch {reject(bridgeError(UNAVAILABLE,'bridge_unavailable'));return;}
    const body=JSON.stringify({name,arguments:args});
    const req=http.request({hostname:'127.0.0.1',port:config.port,path:'/call',method:'POST',headers:{Authorization:'Bearer '+config.secret,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      let output='',size=0;
      res.on('data',chunk=>{size+=chunk.length;if(size>MAX){res.destroy();reject(Error('MCP response too large.'));return;}output+=chunk;});
      res.on('error',()=>reject(bridgeError(UNAVAILABLE,'bridge_unavailable')));
      res.on('end',()=>{let parsed;try{parsed=JSON.parse(output);}catch{reject(bridgeError(UNAVAILABLE,'bridge_unavailable'));return;}if(res.statusCode!==200 || parsed.error)reject(bridgeError(String(parsed.error || 'Bridge request failed.'),typeof parsed.code==='string'?parsed.code:'rejected'));else resolve(parsed.result);});
    });
    req.setTimeout(budget(name,args),()=>req.destroy());req.on('error',()=>reject(bridgeError(UNAVAILABLE,'bridge_unavailable')));req.end(body);
  });
}
// Claude's MCP configuration must survive extension updates, so it points at a copy in private storage
// instead of the versioned extension folder. Each file is replaced atomically.
function installLauncher(root, version) {
  const bin=path.join(root,'bin');
  fs.mkdirSync(bin,{recursive:true,mode:0o700});
  // The server is replaced last, so a process started mid-update never pairs a new server with an old bridge.
  const files={'mcp-bridge.cjs':fs.readFileSync(__filename),'version.json':Buffer.from(JSON.stringify({version})),'mcp-server.cjs':fs.readFileSync(path.join(__dirname,'mcp-server.cjs'))};
  for(const [name,content] of Object.entries(files)) {
    const target=path.join(bin,name);
    try{if(fs.readFileSync(target).equals(content))continue;}catch{}
    const temporary=target+'.'+process.pid+'.tmp';
    fs.writeFileSync(temporary,content,{mode:0o600});
    fs.renameSync(temporary,target);
  }
  return path.join(bin,'mcp-server.cjs');
}
module.exports={serve,request,privateDirectory,installLauncher};
