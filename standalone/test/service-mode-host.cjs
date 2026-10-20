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
  const data=require('./service-fixture.cjs').fixture(root,{nodePath:'node'});let service,peer,api,activationContext;
  const entry=require('../extension.cjs'),activate=entry.activate;entry.activate=context=>{activationContext=context;return activate(context);};
  try {
    const formatted=hostError({stack:'Error: Synthetic real assertion detail\n at '+path.join(root,'synthetic.cjs')+'\n at '+__filename},[root,path.resolve(__dirname,'..')]);
    assert.match(formatted,/Synthetic real assertion detail/);assert(!formatted.includes(root));assert(!formatted.includes(__dirname));
    let assertion;try{assert.equal(path.join(root,'synthetic.cjs'),'synthetic expected');}catch(error){assertion=error;}
    const assertionText=hostError(assertion,[root,path.resolve(__dirname,'..')]);assert.match(assertionText,/AssertionError/);assert.match(assertionText,/synthetic expected/);
    assert(!assertionText.includes(root));assert(!assertionText.includes(JSON.stringify(root).slice(1,-1)));
    service=await require('../runtime/service-main.cjs').runService({root,hostOptions:data.hostOptions});
    await vscode.workspace.getConfiguration('rundix').update('mcpService', 'service', vscode.ConfigurationTarget.Global);
    await assert.rejects(vscode.workspace.getConfiguration('rundix').update('mcpService', 'window', vscode.ConfigurationTarget.Workspace));
    launcher.installLauncherAsync = () => {installs++;return {root,launcher:'synthetic-launcher', configuration:{mcpServers:{rundix:{command:'node', args:['synthetic-launcher','--service']}}}};};
    api = await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();
    assert.equal(api.mcp.panelSnapshot().serviceMode, true, 'Only globalValue chooses mode');
    await assert.rejects(api.mcp.connectPool(), {code:'unsupported'});
    assert.equal(await api.mcp.start(), 'synthetic-launcher');
    assert.equal(installs, 1); assert.equal(api.mcp.tasks(), null, 'No window MCP host started');
    const result = await api.mcp.panelAction({action:'configuration'});
    assert.deepEqual(result.configuration.mcpServers.rundix.args, ['synthetic-launcher','--service']);
    assert.deepEqual(api.mcp.panelSnapshot().tasks, []);
    const spaceId=api.mcp.panelSnapshot().spaceId;
    assert(spaceId);assert.equal(api.mcp.panelSnapshot().bridgeRunning,true);
    peer=await require('../runtime/service-endpoint.cjs').connectService({root,hello:{clientKind:'adapter',binding:{source:'cwd',launchDirectory:vscode.workspace.workspaceFolders[0].uri.fsPath}}});
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
    chat.panel.dispose();report.serviceTaskTab=true;report.windowDraftDurable=true;report.noSecondThreadOwner=true;
    await api.mcp.panelAction({action:'cancel',spaceId,taskId:task.taskId,requestId:'synthetic-panel-cancel'});
    await api.mcp.panelAction({action:'close',spaceId,taskId:task.taskId,requestId:'synthetic-panel-close'});
    assert.equal(api.mcp.panelSnapshot().tasks[0].closed,true);
    report.windowServicePanel=true;report.sameChatContinuation=true;report.cancelAndCloseRouted=true;
    await api.mcp.start(); assert.equal(installs, 1);
    const settingsFile=path.join(root,'settings.json');
    await vscode.workspace.getConfiguration('rundix').update('mcpAccessMode','manual',vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('rundix').update('mcpThreadConfig',{model:'synthetic-model'},vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('rundix').update('cliPath',process.execPath,vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('rundix').update('mcpMaxParallelTasks',2,vscode.ConfigurationTarget.Global);
    const deadline=Date.now()+5000;while(Date.now()<deadline){if(JSON.parse(fs.readFileSync(settingsFile,'utf8')).mcpMaxParallelTasks===2)break;await new Promise(resolve=>setTimeout(resolve,20));}
    const settings=JSON.parse(fs.readFileSync(settingsFile,'utf8'));assert.equal(settings.mcpAccessMode,'manual');assert.equal(settings.mcpMaxParallelTasks,2);assert.deepEqual(settings.mcpThreadConfig,{model:'synthetic-model'});assert.equal(settings.cliPath,process.execPath);
    const stale=api.mcp.start().catch(()=>{}),stop=api.mcp.stop(),restart=api.mcp.start();
    await Promise.all([stale,stop,restart]);assert.equal(api.mcp.panelSnapshot().bridgeRunning,true,'Explicit restart outlives stale start');
    report.startStopStart=true;
    await api.mcp.stop(); assert.equal(api.mcp.panelSnapshot().bridgeRunning, false);
    assert.equal(activationContext.globalState.get('mcpServiceStopped'),true);
    for(const staleEnabled of [false,true]){
      await activationContext.globalState.update('mcpEnabled',staleEnabled);
      for(const subscription of activationContext.subscriptions.splice(0).reverse())await subscription.dispose();
      const beforeReload=installs;api=await activate(activationContext);
      await api.mcp.panelAction({action:'ready'});await api.mcp.panelAction({action:'refresh'});
      assert.equal(installs,beforeReload,'Persisted Stop overrides stale enabled flag after interrupted writes');assert.equal(api.mcp.panelSnapshot().bridgeRunning,false);
    }
    await api.mcp.start();assert.equal(activationContext.globalState.get('mcpServiceStopped'),false);assert.equal(api.mcp.panelSnapshot().bridgeRunning,true);
    await api.mcp.stop();report.stopPersistsAcrossReload=true;
    report.globalOnly = true; report.noWindowExecutor = true; report.serviceConfiguration = true; report.passed = true;
  } catch (error) {report.error = hostError(error,[root,activationContext?.globalStorageUri.fsPath,path.resolve(__dirname,'..'),os.tmpdir(),os.homedir(),process.execPath]);report.passed = false;}
  finally {
    await api?.mcp.stop();peer?.close();await service?.shutdown();await data.close();
    launcher.installLauncherAsync = original;entry.activate=activate;fs.writeFileSync(path.join(__dirname,'../.verification/service-mode-host.json'), JSON.stringify(report,null,2));
    assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-service-panel-synthetic-'));fs.rmSync(root,{recursive:true,force:true});
  }
};
