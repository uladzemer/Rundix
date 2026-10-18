const assert=require('node:assert/strict');const {spawn}=require('node:child_process');const path=require('node:path');
const {AppServer}=require('../runtime/transport.cjs');const {notification}=require('../runtime/session.cjs');
(async()=>{
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
 console.log('PASS: JSONL framing, initialization, server approvals, streamed answer, session isolation, process exit cleanup.');
})().catch(e=>{console.error(e);process.exitCode=1});
