const assert=require('node:assert/strict');const {spawn}=require('node:child_process');const path=require('node:path');
const {AppServer}=require('../runtime/transport.cjs');const {notification}=require('../runtime/session.cjs');
async function hostCwdChecks(){
 const fs=require('node:fs'),os=require('node:os'),vm=require('node:vm');
 const source=fs.readFileSync(path.join(__dirname,'../extension.cjs'),'utf8');
 const start=source.indexOf('  async function connect() {'),end=source.indexOf('  async function refreshAccount()',start);
 assert(start>=0 && end>start);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-server-cwd-synthetic-'));
 const project=path.join(root,'task'),storage=path.join(root,'storage');
 fs.mkdirSync(project);fs.mkdirSync(storage);
 let client;
 const close=async()=>{const child=client?.child,closed=child?new Promise(resolve=>child.once('close',resolve)):Promise.resolve();client?.dispose();await closed;};
 try{
  for(const workspace of [project,undefined]){
   const context={connecting:null,activeConnection:null,connectionStarting:false,server:null,
    connections:{resolve:async()=>({id:'synthetic-local'}),assertCurrent(){}},resolveCli:async()=>path.join('synthetic-cli','codex.exe'),
    fs,path,cwd:()=>workspace,context:{globalStorageUri:{fsPath:storage}},cliPrepared:null,cliCheckRequest:{},
    refreshAccount:async()=>{},refreshCatalog:async()=>{},
    AppServer:class extends AppServer{constructor(options){super({...options,spawnProcess:(executable,_args,options)=>{
     assert.ok(executable===path.resolve('synthetic-cli','codex.exe'),'Relative configured CLI paths resolve before changing the child cwd');
     return spawn(process.execPath,[path.join(__dirname,'fake-server.cjs')],options);
    }});}},
   };
   const connect=vm.runInNewContext('('+source.slice(start,end).trim()+')',context);
   client=await connect();
   // Exercise the host's launch options, then handle synthetic turn events locally.
   client.removeAllListeners();
   assert.ok(client.cwd===(workspace?storage:undefined),'Host launch uses neutral storage with a workspace');
   const actual=await client.request('test/cwd');
   assert.ok(actual.cwd===(workspace?storage:process.cwd()),'Only the server cwd changes; empty-window fallback stays intact');
   if(workspace){
    const session={id:'thread-a',items:[]};
    client.on('notification',message=>notification(session,message));
    client.on('request',request=>client.respond(request.id,{decision:'accept'}));
    await client.request('thread/start',{cwd:project});
    const completed=new Promise((resolve,reject)=>{
     const timer=setTimeout(()=>reject(Error('Synthetic completion timeout')),5000);
     client.on('notification',message=>{if(message.method==='turn/completed'){clearTimeout(timer);resolve();}});
    });
    await client.request('turn/start',{threadId:session.id,cwd:project,input:[{type:'text',text:'Synthetic cwd check'}]});
    await completed;assert.equal(session.busy,false);
    fs.rmdirSync(project);
    assert.deepEqual(await client.request('test/ping'),{ok:true},'The task directory is removable while the shared server remains alive');
   }
   await close();
  }
 }finally{
  await close();
  assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('rundix-server-cwd-synthetic-'));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});
 }
}
(async()=>{
 await hostCwdChecks();
 // The synthetic server must not resolve a user's CLI before calling the injected spawn.
 const s=new AppServer({executable:process.execPath,spawnProcess:()=>spawn(process.execPath,[path.join(__dirname,'fake-server.cjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']})});
 const a={id:'thread-a',items:[]},b={id:'thread-b',items:[]};let request;
 s.on('notification',m=>{notification(a,m);notification(b,m)});s.on('request',r=>request=r);
 try{
  assert.equal((await s.start()).codexHome,'fixture');
  await s.request('turn/start',{threadId:a.id,input:[{type:'text',text:'fixture'}]});
  for(let n=0;n<50&&!request;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(request.params.threadId,a.id);assert.equal(b.items.length,0);assert.equal(s.respond('unknown',{}),false);
  assert.ok(s.respond(request.id,{decision:'accept'}));
  for(let n=0;n<50&&a.busy;n++)await new Promise(r=>setTimeout(r,10));
  assert.equal(a.items[0].text,'Hello');assert.equal(a.busy,false);assert.equal(b.items.length,0);
  assert.ok(Number.isFinite(a.turnStartedAt));
  await assert.rejects(s.request('test/exit'),/завершился/);assert.equal(s.pending.size,0);
  assert.equal((await s.start()).codexHome,'fixture','Restart after process exit');
  assert.deepEqual(await s.request('test/ping'),{ok:true});
  let disconnected=0;s.on('disconnected',()=>disconnected++);
  s.dispose();assert.equal((await s.start()).codexHome,'fixture');
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.deepEqual(await s.request('test/ping'),{ok:true});
  assert.equal(disconnected,0,'Intentional disposal and late exit cannot invalidate a new connection');
 }finally{s.dispose();}
 console.log('PASS: neutral host cwd, live-server task directory removal, empty-window cwd, JSONL framing, approvals, session isolation, process exit cleanup.');
})().catch(e=>{console.error(e);process.exitCode=1});
