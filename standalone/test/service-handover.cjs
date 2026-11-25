require('./test-isolation.cjs').isolate();
const assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {compareVersions,handoverTarget}=require('../runtime/service-version.cjs');
const {runService}=require('../runtime/service-main.cjs');
const {connectService,readDiscovery,locations,startService,probeOwner}=require('../runtime/service-endpoint.cjs');
const {createServiceConnection}=require('../runtime/service-connection.cjs');
const {registerRoot}=require('../runtime/service-migration.cjs');
const {ServiceWindowClient}=require('../runtime/service-window-client.cjs');
const {fixture}=require('./service-fixture.cjs');
const {SessionStore}=require('../runtime/store.cjs');
const currentVersion=require('../package.json').version;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check) {
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){if(await check())return;await pause(20);}
  assert.fail('Synthetic handover deadline');
}
function registration(root, version) {
  const copy=path.join(root,'versions','synthetic-copy'), runtime=path.join(copy,'runtime');
  fs.mkdirSync(runtime,{recursive:true});
  const value={schemaVersion:1,version,nodePath:process.execPath,entryPath:path.join(runtime,'service-main.cjs'),adapterPath:path.join(runtime,'service-adapter.cjs')};
  for (const file of [value.entryPath,value.adapterPath]) fs.writeFileSync(file,'/* Synthetic registration fixture */');
  for (const name of ['complete','package']) fs.writeFileSync(path.join(copy,name+'.json'),JSON.stringify({version}));
  const write=()=>fs.writeFileSync(path.join(root,'installation.json'),JSON.stringify(value),{mode:0o600});
  write();
  return {copy,value,write};
}
function validation(root) {
  assert.equal(compareVersions('0.4.9','0.4.10'),-1);
  assert.equal(compareVersions('1.0.0','1.0.0'),0);
  assert.equal(compareVersions('0.4.24-beta','0.4.23'),null);
  for (const version of [currentVersion,'0.0.1','invalid']) {
    registration(root,version);
    assert.equal(handoverTarget(root,currentVersion),null);
  }
  const {copy,value,write}=registration(root,'9.0.0');
  assert.equal(handoverTarget(root,currentVersion).version,'9.0.0');
  const complete=path.join(copy,'complete.json'), saved=fs.readFileSync(complete);
  fs.unlinkSync(complete);
  assert.equal(handoverTarget(root,currentVersion),null);
  fs.writeFileSync(complete,saved);
  const manifest=path.join(copy,'package.json');
  fs.writeFileSync(manifest,'{"version":"1.0.0"}');
  assert.equal(handoverTarget(root,currentVersion),null);
  fs.writeFileSync(manifest,saved);
  for (const field of ['nodePath','entryPath','adapterPath']) {
    const old=value[field];
    value[field]=path.join(root,'synthetic-absent');write();
    assert.equal(handoverTarget(root,currentVersion),null);
    value[field]=old;
  }
  value.adapterPath=path.join(root,'synthetic-outside.cjs');
  fs.writeFileSync(value.adapterPath,'');write();
  assert.equal(handoverTarget(root,currentVersion),null);
}
const hello=(root,kind)=>kind==='window'
  ? {clientKind:'window',binding:{windowId:'synthetic-window',trusted:true,workspaceFolders:[require('node:url').pathToFileURL(root).href]}}
  : {clientKind:'adapter',binding:{launchDirectory:root,source:'cwd'}};
const open=(root,kind)=>connectService({root,hello:hello(root,kind)});
const retire=(peer,force)=>peer.call('service.retire',{bindingId:peer.binding.bindingId,force});
function deferred() {
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
async function taskCall(peer,name,args={}) {
  const result=await peer.call('task.call',{bindingId:peer.binding.bindingId,spaceId:peer.binding.spaceId,name,arguments:args});
  if (result.error) throw Object.assign(Error(result.error.code),result.error);
  return result.result;
}
async function handshake(root) {
  const entered=deferred(),release=deferred();
  let serverPeer;
  const endpoint=await startService({root,ipc:{hello:async(_params,peer)=>{
    serverPeer=peer;
    entered.resolve();await release.promise;
    return {spaces:[],capabilities:['spaceSnapshot.v1']};
  }}});
  const window=new ServiceWindowClient({root,trusted:true,workspaceFolders:[]});
  try {
    await endpoint.ready();
    const start=window.start();
    await entered.promise;
    assert(endpoint.handoverBusy(),'Async legacy hello is counted before the peer becomes authenticated');
    release.resolve();await start;
    await assert.rejects(window.retire(window.peer,true),{code:'method_not_supported'});
    await until(()=>!endpoint.handoverBusy());
    serverPeer.socket.cork();
    const ping=window.peer.request('service.ping');
    await until(()=>serverPeer.writes>0);
    assert(endpoint.handoverBusy(),'An unflushed response blocks handover');
    serverPeer.socket.uncork();await ping;
    await until(()=>!endpoint.handoverBusy());
  } finally {release.resolve();window.close();await endpoint.dispose();}
}
async function closedConnection(root) {
  fs.mkdirSync(root,{recursive:true});registration(root,currentVersion);
  const launched=deferred();
  const connection=createServiceConnection({root,startupTimeoutMs:10000,spawnProcess(){
    launched.resolve();return {on(){},unref(){}};
  }},hello(root,'adapter'));
  try {
    const request=assert.rejects(connection.connect(),{code:'service_unavailable'});
    await launched.promise;await pause(150);
    const start=Date.now();connection.close();await request;
    assert(Date.now()-start<750,'Closing during connection retries cancels the startup deadline');
  } finally {connection.close();}
}
async function graceful(root) {
  const data=fixture(root);
  registration(root,currentVersion);
  const service=await runService({root,hostOptions:data.hostOptions});
  const window=await open(root,'window');
  let successor, spawned, spawns=0;
  const connection=createServiceConnection({root,spawnProcess(){
    spawns++;
    spawned=runService({root});
    return {on(){},unref(){}};
  }},hello(root,'adapter'));
  try {
    await service.host.core.connect();
    await until(()=>!service.host.handoverBusy() && !service.endpoint.handoverBusy());
    const provider=data.children[0].child, cli=data.children[1].child, kill=provider.kill.bind(provider), stopping=deferred();
    provider.kill=()=>{stopping.resolve();return true;};
    try {
      assert.deepEqual(await retire(window,false),{result:{retiring:true}});
      await stopping.promise;
      assert(cli.exitCode!==null || cli.signalCode!==null,'Graceful retire confirms CLI exit first');
      assert.equal(readDiscovery(locations({root})).generation,window.generation,'Discovery remains published while the provider is alive');
      assert.equal((await probeOwner({root})).state,'responding','Closing owner still answers discovery probes');
      const next=connection.connect();
      await pause(280);
      assert.equal(spawns,0,'Contending client waits while the previous owner holds the endpoint');
      provider.kill=kill;kill();
      const peer=await next;
      successor=await spawned;
      assert.equal(successor.status,'owner');
      assert.equal(spawns,1);
      assert.notEqual(peer.generation,window.generation);
    } finally {provider.kill=kill;}
  } finally {window.close();connection.close();await successor?.shutdown();await service.shutdown();await data.close();}
}
async function guards(root, legacy) {
  fs.mkdirSync(root,{recursive:true});
  const entered=deferred(),release=deferred();
  let time=0;
  const service=await runService({root,idleMs:60000,pollMs:10,handoverOptions:{quietMs:100,checkMs:10,now:()=>time},
    migrationOptions:{retryMs:30,hooks:{afterCopy(){entered.resolve();return release.promise;}}}});
  const adapter=await open(root,'adapter');
  const advance=async()=>{
    await pause(55);time+=200;await pause(55);
    assert.equal(readDiscovery(locations({root}))?.generation,adapter.generation);
  };
  try {
    registration(root,'9.0.0');
    const task={taskId:'synthetic-guard-task',sessionKey:'synthetic-guard-session',projectDirectory:root,space:adapter.binding.spaceId,operations:[],state:'queued'};
    service.host.mcp.tasks.tasks.set(task.taskId,task);
    await advance();
    task.state='waiting_limit';task.waitingLimit={resetAt:Date.now()+3600000};
    await advance();
    task.state='error';task.recoveryRequired=true;
    await advance();
    task.state='completed';task.recoveryRequired=false;
    const waiting=taskCall(adapter,'wait_task',{taskId:task.taskId,afterRevision:10,waitSeconds:2});
    await until(()=>service.endpoint.busy());
    await advance();
    await waiting;
    const legacyTasks=new SessionStore(path.join(legacy,'mcp','tasks'));
    legacyTasks.write('mcp-task','synthetic-legacy',{...task,taskId:'synthetic-legacy',sessionKey:'synthetic-legacy-session'});
    registerRoot(root,legacy);
    await entered.promise;
    await advance();
    release.resolve();
    await until(()=>fs.existsSync(path.join(legacy,'mcp','service-migration.json')));
    const handoverBusy=service.host.handoverBusy;
    let paused=false, checks=0;
    const pauseTasks=service.host.mcp.tasks.pause.bind(service.host.mcp.tasks);
    const resumeTasks=service.host.mcp.tasks.resume.bind(service.host.mcp.tasks);
    service.host.mcp.tasks.pause=()=>{paused=true;pauseTasks();};
    service.host.mcp.tasks.resume=()=>{paused=false;resumeTasks();};
    service.host.handoverBusy=()=>{if(paused){checks++;return true;}return handoverBusy();};
    await until(async()=>{await advance();return checks>0;});
    assert(await taskCall(adapter,'get_task',{taskId:task.taskId}),'Client stays usable after the abandoned decision');
  } finally {release.resolve();adapter.close();await service.shutdown();}
}
async function stuckMigration(root, retryRoot, repairRoot) {
  fs.mkdirSync(root,{recursive:true});
  const retryTasks=new SessionStore(path.join(retryRoot,'mcp','tasks'));
  const repairTasks=new SessionStore(path.join(repairRoot,'mcp','tasks'));
  const task={sessionKey:'synthetic-session',projectDirectory:root,operations:[],state:'completed'};
  for(const taskId of ['synthetic-first','synthetic-second'])retryTasks.write('mcp-task',taskId,{...task,taskId});
  let metadata='synthetic leaf';
  for(let depth=0;depth<63;depth++)metadata={metadata};
  // The source fits the parser depth but the wrapped migration row does not.
  repairTasks.write('mcp-task','synthetic-deep',{...task,taskId:'synthetic-deep',metadata});
  for(const source of [retryRoot,repairRoot])registerRoot(root,source);
  let retries=0;
  const service=await runService({root,pollMs:10,handoverOptions:{quietMs:400,checkMs:10},
    migrationOptions:{retryMs:15,clock:()=>Date.now()*1000,hooks:{afterCopy(copied){
      if(copied===2){retries++;throw Object.assign(Error('Synthetic migration retry'),{code:'EPERM'});}
    }}}});
  const adapter=await open(root,'adapter');
  try {
    for(const [source,state] of [[retryRoot,'retry_later'],[repairRoot,'needs_repair']]){
      const binding=hello(root,'window').binding;
      const window=await connectService({root,hello:{clientKind:'window',binding:{...binding,legacyRoot:source}}});
      try{assert.equal(window.binding.legacyStatus.state,state);}finally{window.close();}
    }
    registration(root,'9.0.0');
    await until(()=>!readDiscovery(locations({root})));
    assert(retries>=3,'Repeated failed imports do not reset the quiet window');
  } finally {adapter.close();await service.shutdown();}
}
async function failedAutomatic(root) {
  fs.mkdirSync(root,{recursive:true});
  const data=fixture(root);
  data.hostOptions.providerOptions.recoveryBackoffMs=10;
  let time=0, attempts=0;
  const service=await runService({root,hostOptions:data.hostOptions,pollMs:10,
    handoverOptions:{quietMs:100,checkMs:10,failureBackoffMs:10000,now:()=>time}});
  const adapter=await open(root,'adapter');
  try {
    await service.host.core.connect();
    await until(()=>!service.host.handoverBusy() && !service.endpoint.handoverBusy());
    const previousProvider=service.host.provider.authority.providerGeneration;
    const cli=service.host.provider.cli, stop=cli.stop.bind(cli);
    cli.stop=async()=>{
      cli.stop=stop;
      await stop();throw Error('Synthetic failure after CLI exits');
    };
    const dispose=service.host.dispose;
    service.host.dispose=async options=>{
      if(options?.confirmProviderExit)attempts++;
      return dispose(options);
    };
    registration(root,'9.0.0');
    await until(()=>{time+=150;return attempts===1;});
    await until(()=>service.host.provider.authority.providerGeneration!==previousProvider && !service.host.handoverBusy());
    const task=await taskCall(adapter,'submit_task',{requestId:'synthetic-after-failed-handover',description:'Synthetic recovery task',
      acceptanceCriteria:'Synthetic checks',projectDirectory:root});
    await until(()=>service.host.mcp.tasks.tasks.get(task.taskId).state==='completed');
    await until(()=>!service.host.handoverBusy());
    for(let i=0;i<4;i++){time+=500;await pause(50);}
    assert.equal(attempts,1,'Automatic handover retries only once the configured backoff passes');
    assert.equal(readDiscovery(locations({root})).generation,adapter.generation);
  } finally {adapter.close();await service.shutdown();await data.close();}
}
async function forced(root, phase) {
  const repo=path.join(root,'synthetic-project'), second=path.join(root,'synthetic-second-project');
  for (const dir of [repo,second]) fs.mkdirSync(dir,{recursive:true});
  const dispatchGate=path.join(root,'synthetic-dispatch-gate');
  const superseded=phase==='superseded', clarification=phase==='clarification' || superseded;
  const recover=clarification || phase==='initial';
  const cliEnv={RUNDIX_SYNTHETIC_DISPATCH_GATE:dispatchGate};
  const data=fixture(root,{cliEnv}), sends=[];
  const timeout=deferred();
  const makeCli=data.hostOptions.providerOptions.createCli;
  data.hostOptions.providerOptions.createCli=options=>{
    const cli=makeCli(options), request=cli.request.bind(cli);
    cli.request=(method,params,...args)=>{
      if(method!=='turn/start')return request(method,params,...args);
      sends.push(params.input);
      const pending=request(method,params,...args);
      return superseded && sends.length===2?Promise.race([pending,timeout.promise.then(()=>{
        throw Object.assign(Error('Synthetic missing ACK'),{deliveryUncertain:true});
      })]):pending;
    };
    return cli;
  };
  registration(root,currentVersion);
  let service, adapter, window, other;
  try {
    service=await runService({root,hostOptions:data.hostOptions});
    adapter=await connectService({root,hello:hello(repo,'adapter')});
    window=await open(root,'window');
    other=await connectService({root,hello:hello(second,'adapter')});
    assert.equal(window.serviceVersion,currentVersion);
    assert(window.binding.capabilities.includes('service.retire'));
    await assert.rejects(retire(adapter,true),{code:'method_not_supported'});
    await assert.rejects(window.request('service.retire',{force:true,bindingId:window.binding.bindingId,generation:'synthetic-wrong'}),{code:'stale_instance'});
    const args={requestId:'synthetic-first',description:'Synthetic initial input',acceptanceCriteria:'Synthetic checks',projectDirectory:repo};
    if(!clarification)fs.writeFileSync(dispatchGate,recover?'waiting':phase==='observed'?'deliver':'ack');
    const submitted=await taskCall(adapter,'submit_task',args);
    const oldTasks=service.host.mcp.tasks, oldTask=oldTasks.tasks.get(submitted.taskId);
    if(clarification){
      await until(()=>oldTask.state==='completed');
      fs.writeFileSync(dispatchGate,'waiting');
      await taskCall(adapter,'continue_task',{taskId:oldTask.taskId,requestId:'synthetic-ambiguous',clarification:'Synthetic ambiguous input'});
    }
    if(recover){
      await until(()=>oldTask.deliveryPhase==='dispatching' && fs.readFileSync(dispatchGate,'utf8')==='received');
    }else if(phase==='observed')await until(()=>oldTask.deliveryPhase==='dispatching' && service.host.core.sessions.get(oldTask.sessionKey)?.items.some(item=>item.type==='userMessage'));
    else await until(()=>oldTask.deliveryPhase==='confirmed');
    const interruptedInput=sends.at(-1)[0].text;
    const otherTask=await taskCall(other,'submit_task',{...args,requestId:'synthetic-other',projectDirectory:repo});
    assert.deepEqual(await retire(window,false),{result:{retiring:false,activeTasks:2,reason:'tasks'}});
    assert.equal((await taskCall(adapter,'get_task',{taskId:oldTask.taskId})).state,'running');
    await taskCall(other,'cancel_task',{taskId:otherTask.taskId,requestId:'synthetic-cancel-other'});
    const replacement='Synthetic queued replacement';
    if(superseded){
      oldTasks.pause();
      timeout.resolve();
      await until(()=>oldTask.state==='error');
      await taskCall(adapter,'continue_task',{taskId:oldTask.taskId,requestId:'synthetic-replacement',clarification:replacement});
      assert.equal(oldTask.nextInput,replacement,'The later clarification now owns the slot while the old run is still live');
    }
    const generation=window.generation, sent=sends.length;
    let failedRecoveryWrite=false;
    if(phase==='clarification'){
      const write=oldTasks.store.write.bind(oldTasks.store);
      oldTasks.store.write=(kind,id,value)=>{
        if(!failedRecoveryWrite && kind==='mcp-task' && id===oldTask.taskId && value.unsentInputs?.length){
          failedRecoveryWrite=true;
          throw Error('Synthetic transient recovery write failure');
        }
        return write(kind,id,value);
      };
    }
    const providerChild=data.children.find(row=>row.child.spawnargs.some(arg=>arg.endsWith('provider-entry.cjs'))).child;
    const killProvider=providerChild.kill.bind(providerChild);
    let delayedKill, providerClosed=false;
    providerChild.once('close',()=>{providerClosed=true;});
    providerChild.kill=()=>{delayedKill ??= setTimeout(killProvider,250);return true;};
    assert.deepEqual(await retire(window,true),{result:{retiring:true}},'Retire ACK arrives before the transport closes');
    await until(()=>!readDiscovery(locations({root})));
    if(phase==='clarification')assert(failedRecoveryWrite,'The exit handler encountered the injected recovery write failure');
    fs.unlinkSync(dispatchGate);
    service=await runService({root,hostOptions:data.hostOptions});
    assert(providerClosed,'The old provider closed before the successor can start a provider');
    adapter=await connectService({root,hello:hello(repo,'adapter')});
    assert.notEqual(adapter.generation,generation);
    const task=await taskCall(adapter,'get_task',{taskId:oldTask.taskId});
    assert.equal(task.state,'error');assert.equal(task.recoveryRequired,false);
    const store=new SessionStore(path.join(root,'sessions-v1'));
    assert(!fs.readdirSync(store.directory).some(name=>name.startsWith('task-directory-')),'Confirmed CLI exit releases the directory');
    assert.equal(sends.length,sent,'New generation never replays the interrupted call');
    const record=service.host.mcp.tasks.tasks.get(task.taskId);
    const expected=recover?[interruptedInput]:[];
    if(superseded)expected.push(replacement);
    assert.deepEqual(task.unsentInputs.map(item=>item.text),expected,'Only unconfirmed and queued inputs are recoverable after restart');
    assert.equal(record.nextInput,undefined,'An interrupted input is removed from the execution slot');
    assert.equal(task.unsentInputCount,expected.length);
    if(recover){
      const session=service.host.core.store.session(record.sessionKey);
      assert(!JSON.stringify(session?.items || []).includes(interruptedInput),'Synthetic CLI never accepted that input into its chat');
    }
    const waited=await taskCall(adapter,'wait_task',{taskId:task.taskId,waitSeconds:1});
    const listed=(await taskCall(adapter,'list_tasks')).tasks.find(item=>item.taskId===task.taskId);
    assert.equal(waited.unsentInputCount,task.unsentInputCount);
    assert.equal(listed.unsentInputCount,task.unsentInputCount);
    window=await connectService({root,hello:hello(repo,'window')});
    const binding={bindingId:window.binding.bindingId,spaceId:adapter.binding.spaceId};
    const panel=await window.call('space.subscribe',binding);
    const panelTask=panel.result.tasks.find(item=>item.taskId===task.taskId);
    assert.equal(panelTask.unsentInputCount,task.unsentInputCount);
    for(const view of [waited,listed,panelTask])assert.equal(Object.hasOwn(view,'unsentInputs'),false);
    if(phase==='observed'){
      const chat=await window.call('chat.open',{...binding,taskId:task.taskId});
      assert(chat.result.items.some(item=>item.type==='userMessage' && item.text===interruptedInput),'The delivered input stays visible in the chat after restart');
    }
    const resumed=await taskCall(adapter,'continue_task',{taskId:task.taskId,requestId:'synthetic-resume',clarification:'Synthetic manual continuation'});
    assert.equal(resumed.taskId,task.taskId);
    await until(()=>service.host.mcp.tasks.tasks.get(task.taskId).state==='completed');
    oldTasks.save(oldTask);
    assert.equal(service.host.mcp.tasks.store.read('mcp-task',task.taskId).state,'completed','A disposed generation cannot overwrite a recovered task');
    assert.equal(sends.filter(input=>JSON.stringify(input).includes('Synthetic manual continuation')).length,1);
    assert.equal(sends.filter(input=>input[0].text===interruptedInput).length,1,'The interrupted input is never replayed');
    assert.deepEqual((await taskCall(adapter,'get_task',{taskId:task.taskId})).unsentInputs,task.unsentInputs,'Manual Continue preserves the recovery entries');
  } finally {adapter?.close();window?.close();other?.close();await service?.shutdown();await data.close();}
}
async function main() {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-handover-synthetic-'));
  try {
    validation(path.join(base,'validation'));
    await handshake(path.join(base,'handshake'));
    await closedConnection(path.join(base,'closed-connection'));
    await guards(path.join(base,'guards'),path.join(base,'legacy'));
    await stuckMigration(path.join(base,'stuck-migration'),path.join(base,'retrying-root'),path.join(base,'repair-root'));
    await failedAutomatic(path.join(base,'failed-automatic'));
    fs.mkdirSync(path.join(base,'graceful'));
    await graceful(path.join(base,'graceful'));
    await forced(path.join(base,'running'),'acknowledged');
    await forced(path.join(base,'dispatching'),'clarification');
    await forced(path.join(base,'first-input'),'initial');
    await forced(path.join(base,'observed'),'observed');
    await forced(path.join(base,'superseded'),'superseded');
  } finally {assert.equal(path.dirname(base),os.tmpdir());assert(path.basename(base).startsWith('rundix-handover-synthetic-'));fs.rmSync(base,{recursive:true,force:true});}
  console.log('PASS service handover: target validation, quiescence gates, contention, retire authorization, ACK and actual forced shutdown/recovery.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
