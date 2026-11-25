require('./test-isolation.cjs').isolate();
const vscode = require('vscode'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const os=require('node:os');
function hostError(error,paths){
  let text=String(error?.stack || error);
  for(const value of [...new Set(paths.filter(Boolean))].sort((a,b)=>b.length-a.length)){
    for(const form of [JSON.stringify(value).slice(1,-1),value,value.replace(/\\/g,'/')])text=text.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),'<synthetic-path>');
  }
  return text;
}
exports.run = async () => {
  const report = {syntheticTransport:true, inferencePerformed:false}, launcher = require('../runtime/service-launcher.cjs');
  const original = launcher.installLauncherAsync; let installs = 0;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-service-panel-synthetic-'));
  process.env.RUNDIX_SERVICE_ROOT=root;
  const data=require('./service-fixture.cjs').fixture(root,{nodePath:'node'});let service,peer,api,activationContext;
  const entry=require('../extension.cjs'),activate=entry.activate;entry.activate=context=>{activationContext=context;return activate(context);};
  try {
    const formatted=hostError({stack:'Error: Synthetic real assertion detail\n at '+path.join(root,'synthetic.cjs')+'\n at '+__filename},[root,path.resolve(__dirname,'..')]);
    assert.match(formatted,/Synthetic real assertion detail/);assert(!formatted.includes(root));assert(!formatted.includes(__dirname));
    let assertion;try{assert.equal(path.join(root,'synthetic.cjs'),'synthetic expected');}catch(error){assertion=error;}
    const assertionText=hostError(assertion,[root,path.resolve(__dirname,'..')]);assert.match(assertionText,/AssertionError/);assert.match(assertionText,/synthetic expected/);
    assert(!assertionText.includes(root));assert(!assertionText.includes(JSON.stringify(root).slice(1,-1)));
    const {runService}=require('../runtime/service-main.cjs');
    const {connectService,readDiscovery,locations}=require('../runtime/service-endpoint.cjs');
    const {ServiceWindowClient}=require('../runtime/service-window-client.cjs');
    service=await runService({root,hostOptions:data.hostOptions});
    await vscode.workspace.getConfiguration('rundix').update('mcpService', 'service', vscode.ConfigurationTarget.Global);
    await assert.rejects(vscode.workspace.getConfiguration('rundix').update('mcpService', 'window', vscode.ConfigurationTarget.Workspace));
    launcher.installLauncherAsync = () => {installs++;return {root,launcher:'synthetic-launcher', configuration:{mcpServers:{rundix:{command:'node', args:['synthetic-launcher','--service']}}}};};
    api = await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();
    assert.equal(api.mcp.panelSnapshot().serviceMode, true, 'Only globalValue chooses mode');
    const iconSession=api.create({key:'synthetic-service-icon',name:'Synthetic service icon',cwd:root,items:[]});
    const iconPanel=api.view(iconSession).panel,iconMessages=[];
    const originalPost=iconPanel.webview.postMessage.bind(iconPanel.webview);
    iconPanel.webview.postMessage=message=>{if(message.type==='state')iconMessages.push(message.data.mcpBridgeRunning);return originalPost(message);};
    const waitIcon=async expected=>{const until=Date.now()+5000;while(iconMessages.at(-1)!==expected){assert(Date.now()<until,'Service icon state deadline');await new Promise(resolve=>setTimeout(resolve,20));}};

    await assert.rejects(api.mcp.connectPool(), {code:'unsupported'});
    assert.equal(await api.mcp.start(), 'synthetic-launcher');
    await waitIcon(true);assert.equal(api.mcp.tasks(),null);report.serviceChatIconConnected=true;
    assert.equal(installs, 1); assert.equal(api.mcp.tasks(), null, 'No window MCP host started');
    const result = await api.mcp.panelAction({action:'configuration'});
    assert.deepEqual(result.configuration.mcpServers.rundix.args, ['synthetic-launcher','--service']);
    assert.deepEqual(api.mcp.panelSnapshot().tasks, []);
    const spaceId=api.mcp.panelSnapshot().spaceId;
    assert(spaceId);assert.equal(api.mcp.panelSnapshot().bridgeRunning,true);
    const connectAdapter=()=>connectService({root,hello:{clientKind:'adapter',binding:{source:'cwd',launchDirectory:vscode.workspace.workspaceFolders[0].uri.fsPath}}});
    peer=await connectAdapter();
    const call=async(name,args)=>{
      const result=await peer.call('task.call',{bindingId:peer.binding.bindingId,spaceId:peer.binding.spaceId,name,arguments:args});
      if(result.error)throw Object.assign(Error(result.error.message),result.error);return result.result;
    };
    const task=await call('submit_task',{requestId:'synthetic-panel-submit',description:'Synthetic panel task',acceptanceCriteria:'Synthetic checks',projectDirectory:root});
    const finished=await call('wait_task',{taskId:task.taskId,waitSeconds:5});assert.equal(finished.state,'completed');
    await api.mcp.panelAction({action:'refresh'});
    assert.equal(api.mcp.panelSnapshot().tasks[0].taskId,task.taskId);
    await assert.rejects(api.mcp.panelAction({action:'continue',spaceId:'synthetic-foreign',taskId:task.taskId,requestId:'synthetic-foreign',clarification:'Synthetic'}),{code:'space_not_bound'});
    await api.mcp.panelAction({action:'continue',spaceId,taskId:task.taskId,requestId:'synthetic-panel-continue',clarification:'Synthetic panel continuation'});
    const continued=await call('wait_task',{taskId:task.taskId,waitSeconds:5});assert.equal(continued.state,'completed');assert.equal(continued.chatId,finished.chatId);
    await api.mcp.panelAction({action:'openChat',spaceId,taskId:task.taskId});
    let chat=[...api.mcp.serviceChats.values()][0];assert(chat);assert.equal(chat.snapshot.chatId,finished.chatId);
    assert(chat.snapshot.items.length>0);assert(![...api.sessions.values()].some(session=>session.id===finished.chatId),'Window never resumes service-owned thread');
    await api.mcp.chatAction(chat,{action:'draft',state:{draft:'Synthetic durable tab draft',questionDrafts:{},attempts:{}}});
    await api.mcp.chatAction(chat,{action:'continue',requestId:'synthetic-tab-continue',text:'Synthetic tab continuation'});
    const tabContinued=await call('wait_task',{taskId:task.taskId,waitSeconds:5});assert.equal(tabContinued.chatId,finished.chatId);
    await api.mcp.chatAction(chat,{action:'closeReady',state:{draft:'Synthetic durable tab draft',questionDrafts:{},attempts:{}}});
    await api.mcp.panelAction({action:'openChat',spaceId,taskId:task.taskId});chat=[...api.mcp.serviceChats.values()][0];assert.equal(chat.draftState.draft,'Synthetic durable tab draft');
    const version=require('../package.json').version;
    assert.equal(api.mcp.panelSnapshot().serviceVersion,version);assert.equal(api.mcp.panelSnapshot().serviceCanRestart,true);
    const stub=path.join(root,'versions','synthetic','runtime');
    fs.mkdirSync(stub,{recursive:true});
    const entryPath=path.join(stub,'service-main.cjs'),adapterPath=path.join(stub,'service-adapter.cjs');
    for(const file of [entryPath,adapterPath])fs.writeFileSync(file,'/* Synthetic launcher stub. The test starts the successor. */');
    for(const file of ['package.json','complete.json'])fs.writeFileSync(path.join(stub,'..',file),JSON.stringify({version}));
    fs.writeFileSync(path.join(root,'installation.json'),JSON.stringify({schemaVersion:1,version,nodePath:process.execPath,entryPath,adapterPath}),{mode:0o600});
    const quietDeadline=Date.now()+5000;
    while(service.host.handoverBusy() || service.endpoint.handoverBusy()){
      assert(Date.now()<quietDeadline,'Synthetic service did not become quiescent');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const oldGeneration=service.endpoint.generation, stopPreference=activationContext.globalState.get('mcpServiceStopped');
    const oldEndpoint=service.endpoint, originalBusy=oldEndpoint.handoverBusy;
    const originalWarning=vscode.window.showWarningMessage;
    const prompts=[];
    vscode.window.showWarningMessage=async message=>{prompts.push(message);};
    try {
      let busyCalls=0;
      oldEndpoint.handoverBusy=retiringPeer=>{
        if(!retiringPeer)return originalBusy();
        busyCalls++;return true;
      };
      await api.mcp.panelAction({action:'restartService'});
      assert(busyCalls>1,'Transient restart is retried before prompting');
      assert.equal(prompts.length,1);
      assert.match(prompts[0],/background operation|фоновую операцию/);
      assert.match(prompts[0],/manual continuation|продолжить вручную/);
      assert.match(prompts[0],/may not be delivered|может не дойти/);
      assert.doesNotMatch(prompts[0],/active tasks|активных задач/i);
      assert.equal(readDiscovery(locations({root})).generation,oldGeneration,'Declining keeps the old service');
      let transient=0;
      oldEndpoint.handoverBusy=retiringPeer=>retiringPeer && transient++<2 || originalBusy(retiringPeer);
      const successor=(async()=>{
        const until=Date.now()+15000;
        while(readDiscovery(locations({root}))){
          assert(Date.now()<until,'Synthetic restart did not close the old endpoint');
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        service=await runService({root,hostOptions:data.hostOptions});
      })();
      await Promise.all([api.mcp.panelAction({action:'restartService'}).catch(error=>{
        report.restartFailureCode=error.cause?.code;throw error;
      }),successor]);
      assert(transient>=3);
      assert.equal(prompts.length,1,'Transient work cleared without a forced restart prompt');
    } finally {vscode.window.showWarningMessage=originalWarning;oldEndpoint.handoverBusy=originalBusy;}
    report.restartRetriesTransient=true;
    assert.notEqual(service.endpoint.generation,oldGeneration);
    assert.equal(activationContext.globalState.get('mcpServiceStopped'),stopPreference);
    const chatDeadline=Date.now()+5000;
    while(chat.snapshot?.generation!==service.endpoint.generation){assert(Date.now()<chatDeadline,'Synthetic chat did not re-subscribe');await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(api.mcp.serviceChats.values().next().value,chat);
    assert.equal(chat.draftState.draft,'Synthetic durable tab draft');report.serviceRestartResubscribed=true;
    peer=await connectAdapter();
    chat.panel.dispose();report.serviceTaskTab=true;report.windowDraftDurable=true;report.noSecondThreadOwner=true;
    await api.mcp.panelAction({action:'cancel',spaceId,taskId:task.taskId,requestId:'synthetic-panel-cancel'});
    await api.mcp.panelAction({action:'close',spaceId,taskId:task.taskId,requestId:'synthetic-panel-close'});
    assert.equal(api.mcp.panelSnapshot().tasks[0].closed,true);
    report.windowServicePanel=true;report.sameChatContinuation=true;report.cancelAndCloseRouted=true;
    await api.mcp.start(); assert.equal(installs, 1);
    const settingsFile=path.join(root,'settings.json');
    await api.mcp.panelAction({action:'setModelDefaults',model:'synthetic-model',effort:'medium'});
    assert.equal(vscode.workspace.getConfiguration('rundix').inspect('mcpDefaultModel').globalValue,'synthetic-model');
    assert.equal(vscode.workspace.getConfiguration('rundix').inspect('mcpDefaultEffort').globalValue,'medium');
    const modelSettings=JSON.parse(fs.readFileSync(settingsFile,'utf8'));
    assert.equal(modelSettings.mcpDefaultModel,'synthetic-model');assert.equal(modelSettings.mcpDefaultEffort,'medium');
    await api.mcp.panelAction({action:'setModelDefaults',model:null,effort:'auto'});
    const resetSettings=JSON.parse(fs.readFileSync(settingsFile,'utf8'));
    assert.equal(resetSettings.mcpDefaultModel,undefined);assert.equal(resetSettings.mcpDefaultEffort,undefined);
    const settingsModule=require('../runtime/service-settings.cjs'),originalWrite=settingsModule.writeServiceSettings;
    try {
      settingsModule.writeServiceSettings=async()=>{throw Error('Synthetic settings sync failure');};
      await assert.rejects(api.mcp.panelAction({action:'setModelDefaults',model:'synthetic-model',effort:'medium'}),{code:'settings_write_failed'});
      assert.equal(vscode.workspace.getConfiguration('rundix').inspect('mcpDefaultModel').globalValue,undefined,'Failed sync restores the prior user model');
      assert.equal(vscode.workspace.getConfiguration('rundix').inspect('mcpDefaultEffort').globalValue,undefined,'Failed sync restores the prior user effort');
    }finally{settingsModule.writeServiceSettings=originalWrite;await api.mcp.panelAction({action:'setModelDefaults',model:null,effort:'auto'});}
    await vscode.workspace.getConfiguration('rundix').update('mcpAccessMode','manual',vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('rundix').update('mcpThreadConfig',{model:'synthetic-model'},vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('rundix').update('cliPath',process.execPath,vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('rundix').update('mcpMaxParallelTasks',2,vscode.ConfigurationTarget.Global);
    const deadline=Date.now()+5000;while(Date.now()<deadline){if(JSON.parse(fs.readFileSync(settingsFile,'utf8')).mcpMaxParallelTasks===2)break;await new Promise(resolve=>setTimeout(resolve,20));}
    const settings=JSON.parse(fs.readFileSync(settingsFile,'utf8'));assert.equal(settings.mcpAccessMode,'manual');assert.equal(settings.mcpMaxParallelTasks,2);assert.deepEqual(settings.mcpThreadConfig,{model:'synthetic-model'});assert.equal(settings.cliPath,process.execPath);
    const stale=api.mcp.start().catch(()=>{}),stop=api.mcp.stop(),restart=api.mcp.start();
    await Promise.all([stale,stop,restart]);assert.equal(api.mcp.panelSnapshot().bridgeRunning,true,'Explicit restart outlives stale start');
    report.startStopStart=true;
    await api.mcp.stop(); assert.equal(api.mcp.panelSnapshot().bridgeRunning, false);await waitIcon(false);report.serviceChatIconDisconnected=true;iconPanel.dispose();
    assert.equal(activationContext.globalState.get('mcpServiceStopped'),true);
    for(const staleEnabled of [false,true]){
      await activationContext.globalState.update('mcpEnabled',staleEnabled);
      for(const subscription of activationContext.subscriptions.splice(0).reverse())await subscription.dispose();
      const beforeReload=installs;api=await activate(activationContext);
      await api.mcp.panelAction({action:'ready'});await api.mcp.panelAction({action:'refresh'});
      assert.equal(installs,beforeReload,'Persisted Stop overrides stale enabled flag after interrupted writes');assert.equal(api.mcp.panelSnapshot().bridgeRunning,false);
    }
    const beforeStoppedSettings=installs;
    await vscode.workspace.getConfiguration('rundix').update('mcpMaxParallelTasks',3,vscode.ConfigurationTarget.Global);
    const stoppedSettingsDeadline=Date.now()+5000;
    while(Date.now()<stoppedSettingsDeadline && JSON.parse(fs.readFileSync(settingsFile,'utf8')).mcpMaxParallelTasks!==3)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(JSON.parse(fs.readFileSync(settingsFile,'utf8')).mcpMaxParallelTasks,3,'Stopped/reloaded host uses the isolated fallback root without an installation');
    assert.equal(installs,beforeStoppedSettings);report.stoppedSettingsUseIsolatedRoot=true;
    await api.mcp.start();assert.equal(activationContext.globalState.get('mcpServiceStopped'),false);assert.equal(api.mcp.panelSnapshot().bridgeRunning,true);
    const waitForGeneration=ServiceWindowClient.prototype.waitForGeneration;
    let entered;
    const waiting=new Promise(resolve=>{entered=resolve;});
    ServiceWindowClient.prototype.waitForGeneration=function(...args){entered();return waitForGeneration.apply(this,args);};
    try {
      const pendingRestart=api.mcp.panelAction({action:'restartService'});
      await Promise.race([waiting,pendingRestart.then(()=>assert.fail('Restart did not wait for a successor'))]);
      await api.mcp.panelAction({action:'stop'});
      await pendingRestart;
      assert.equal(api.mcp.panelSnapshot().serviceRestart,null);
      assert.equal(activationContext.globalState.get('mcpServiceStopped'),true);
      report.stopCancelsRestart=true;
    } finally {ServiceWindowClient.prototype.waitForGeneration=waitForGeneration;}
    await api.mcp.stop();report.stopPersistsAcrossReload=true;
    report.globalOnly = true; report.noWindowExecutor = true; report.serviceConfiguration = true; report.passed = true;
  } catch (error) {report.error = hostError(error,[root,activationContext?.globalStorageUri.fsPath,path.resolve(__dirname,'..'),os.tmpdir(),os.homedir(),process.execPath]);report.passed = false;}
  finally {
    await api?.mcp.stop();peer?.close();await service?.shutdown();await data.close();
    launcher.installLauncherAsync = original;entry.activate=activate;fs.writeFileSync(path.join(__dirname,'../.verification/service-mode-host.json'), JSON.stringify(report,null,2));
    assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-service-panel-synthetic-'));fs.rmSync(root,{recursive:true,force:true});
  }
};
