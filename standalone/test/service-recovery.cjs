const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {runService}=require('../runtime/service-main.cjs');
const {connectService}=require('../runtime/service-endpoint.cjs');
const {fixture}=require('./service-fixture.cjs');
const {SessionStore}=require('../runtime/store.cjs');
const net=require('node:net');const {locations}=require('../runtime/service-endpoint.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await pause(20);}throw Error('Synthetic recovery deadline');}
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-recovery-synthetic-'));
 const data=fixture(root,{cliEnv:{RUNDIX_SYNTHETIC_HOLD:'1'}});data.hostOptions.providerOptions.recoveryBackoffMs=10;let providerNow=0;data.hostOptions.providerOptions.now=()=>providerNow;
 let service;const peers=[];
 const connect=async()=>{const peer=await connectService({root,hello:{clientKind:'adapter',binding:{source:'cwd',launchDirectory:root}}});peers.push(peer);return peer;};
 const call=async(peer,name,args={})=>{const value=await peer.call('task.call',{bindingId:peer.binding.bindingId,spaceId:peer.binding.spaceId,name,arguments:args},30000);if(value.error)throw Object.assign(Error(value.error.message),value.error);return value.result;};
 const submit=(peer,id)=>call(peer,'submit_task',{requestId:id,description:'Synthetic recovery task',acceptanceCriteria:'Synthetic checks',projectDirectory:root});
 try{
  service=await runService({root,hostOptions:data.hostOptions});const peer=await connect();
  await service.host.core.connect();
  const prepare=service.host.provider.prepareTurn.bind(service.host.provider);
  service.host.provider.prepareTurn=async()=>{throw Object.assign(Error('Synthetic pre-send failure'),{reason:'action_required',code:'PROVIDER_PROTOCOL_INVALID'});};
  const unsent=await submit(peer,'synthetic-unsent');const rejected=await call(peer,'wait_task',{taskId:unsent.taskId,waitSeconds:2});
  assert.equal(rejected.state,'error');assert.equal(rejected.recoveryRequired,false);assert.equal(rejected.unsentInputCount,1);assert.match(rejected.error,/action_required/);assert.equal(service.host.provider.activeTurns,0);
  service.host.provider.prepareTurn=prepare;
  const expired=await prepare({taskId:'synthetic-expired',spaceId:peer.binding.spaceId,attemptId:'synthetic-attempt'});
  service.host.provider.cli.invalidateProvider();
  await assert.rejects(service.host.provider.dispatchTurn(expired.grant,{threadId:'synthetic-thread'}),{deliveryUncertain:false,notSent:true});
  assert.equal(service.host.provider.activeTurns,0);await service.host.provider.authenticate();
  const task=await submit(peer,'synthetic-live');await until(()=>service.host.provider.activeTurns===1);
  await until(()=>!service.host.mcp.tasks.starting.has(task.taskId) && !service.host.mcp.tasks.executing);
  const adapter=service.host.mcp.tasks.adapter,normalStatus=adapter.status;let failStatus;
  adapter.status=async observed=>observed.taskId===task.taskId?new Promise((_,reject)=>{failStatus=reject;}):normalStatus(observed);
  const checking=service.host.mcp.tasks.tick();await until(()=>failStatus);
  const originalRelease=service.host.mcp.tasks.release;let releaseFailed=false;
  service.host.mcp.tasks.release=function(task){originalRelease.call(this,task);if(!releaseFailed){releaseFailed=true;throw Error('Synthetic release failure');}};
  service.host.provider.on('turnExited',()=>{throw Error('Synthetic downstream listener failure');});
  const extra=await service.host.provider.prepareTurn({taskId:'synthetic-second-exit',spaceId:peer.binding.spaceId,attemptId:'synthetic-second-exit'});
  assert.equal(extra.kind,'ready');assert.equal(service.host.provider.activeTurns,2,'Exit loop must drain multiple grants despite a throwing listener');
  const generation=service.host.provider.cli.binding.appServerGeneration;
  const cli=data.children.find(value=>value.child.spawnargs.some(arg=>arg.endsWith('fake-headless-cli.cjs'))).child;cli.kill();
  await until(async()=>!(await call(peer,'get_task',{taskId:task.taskId})).recoveryRequired && service.host.provider.activeTurns===0);
  assert(releaseFailed,'Exit handler survived a release failure');service.host.mcp.tasks.release=originalRelease;
  failStatus(Error('Synthetic stale status failure'));await checking;adapter.status=normalStatus;
  assert.equal(service.host.mcp.tasks.tasks.get(task.taskId).recoveryRequired,false,'Stale status failure cannot undo confirmed exit');
  await until(()=>service.host.provider.cli.authenticated && service.host.provider.cli.binding.appServerGeneration!==generation);
  const stopped=await call(peer,'get_task',{taskId:task.taskId});assert.equal(stopped.state,'error');assert.equal((await submit(peer,'synthetic-live')).taskId,task.taskId,'No automatic replay after confirmed exit');
  const lost=await submit(peer,'synthetic-provider-loss');await until(()=>service.host.provider.activeTurns===1);
  const providerGeneration=service.host.provider.authority.providerGeneration;
  data.children.find(value=>value.child.exitCode===null && value.child.spawnargs.some(arg=>arg.endsWith('provider-entry.cjs'))).child.kill();
  await until(()=>service.host.provider.authority.providerGeneration!==providerGeneration);
  await until(()=>service.host.provider.activeTurns===0);
  assert.equal((await call(peer,'get_task',{taskId:lost.taskId})).state,'error');
  for(let cycle=0;cycle<6;cycle++){
    await service.host.provider.start();providerNow+=60000;const before=service.host.provider.authority.providerGeneration;
    data.children.find(value=>value.child.exitCode===null && !value.child.killed && value.child.spawnargs.some(arg=>arg.endsWith('provider-entry.cjs'))).child.kill();
    await until(()=>service.host.provider.authority.providerGeneration!==before);await service.host.provider.start();
  }
  const resumed=await submit(peer,'synthetic-explicit-next');await until(()=>service.host.provider.activeTurns===1);
  assert(service.host.provider.cli.authenticated);await call(peer,'cancel_task',{taskId:resumed.taskId,requestId:'synthetic-cancel'});
  await until(()=>service.host.provider.activeTurns===0);
  for(const p of peers)p.close();await pause(50);
  const dispose=service.host.dispose;service.host.dispose=async()=>{throw Error('Synthetic disposal failure');};
  await assert.rejects(service.dispose());service.host.dispose=dispose;
  const restored=await connect();assert((await call(restored,'list_tasks')).tasks.length>=3,'Shutdown failure resumes admissions/poller');restored.close();await pause(50);
  await until(async()=>{await service.host.mcp.tasks.tick();return !service.host.busy();});
  const unlock=new SessionStore(root).acquire('service-startup');
  try {await assert.rejects(service.dispose(),{code:'service_busy'});}finally{unlock();}
  const late=net.createConnection(locations({root}).address);late.on('error',()=>{});await pause(50);
  assert.equal(service.endpoint.clients(),0,'Disposed host cannot accept clients after cleanup failure');late.destroy();
  await until(()=>!fs.existsSync(path.join(root,'bridge.json')));service=null;
  service=await runService({root,hostOptions:data.hostOptions});const fatalPeer=await connect();
  await submit(fatalPeer,'synthetic-fatal-task');await until(()=>service.host.provider.activeTurns===1);
  const runtime=new (require('node:events').EventEmitter)(),codes=[];let exits=0;
  const {installFatalGuards}=require('../runtime/service-fatal.cjs');
  const removeGuards=installFatalGuards({runtime,log:row=>codes.push(row.code),shutdown:()=>service.shutdown(),exit:code=>{assert.equal(code,1);exits++;}});
  runtime.emit('uncaughtException',Error('SYNTHETIC_PRIVATE_EXCEPTION'));runtime.emit('unhandledRejection',Error('SYNTHETIC_PRIVATE_REJECTION'));
  await until(()=>exits===1);assert.deepEqual(codes,['host_error']);assert(!fs.existsSync(path.join(root,'bridge.json')));removeGuards();service=null;
  console.log('PASS service recovery: pre-send input, reserved cleanup, confirmed CLI terminal/re-auth, provider generation restart, no replay and failed idle shutdown rollback.');
 }finally{
  for(const p of peers)p.close();try{await service?.dispose();}catch{}await service?.endpoint.dispose();await data.close();
  assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-recovery-synthetic-'));fs.rmSync(root,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
