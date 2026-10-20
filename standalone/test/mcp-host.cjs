const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {AppServer,findCli}=require('../runtime/transport.cjs');
const {request}=require('../runtime/mcp-bridge.cjs');
exports.run=async()=>{
 const report={syntheticTransport:true,syntheticCompanion:true,inferencePerformed:false};
 const original={start:AppServer.prototype.start,request:AppServer.prototype.request,respond:AppServer.prototype.respond};
 let mcpEditor;
 let api,registration,descriptor,stage='initialization';let turns=0,threads=0,prepared=0,authenticated=0,unsubscribed=0,resumed=0;
 let prepareFailure=false,quotaWait=false,afterWait=async()=>true;const threadConfigs=[];const responses=[];
 const wait=async predicate=>{const until=Date.now()+15000;while(Date.now()<until){const value=await predicate();if(value)return value;await new Promise(r=>setTimeout(r,60));}throw Error('Synthetic scenario timeout');};
 try{
  await vscode.workspace.getConfiguration('rundix').update('cliPath',findCli(),vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration('rundix').update('cliAutoUpdate',false,vscode.ConfigurationTarget.Global);
  AppServer.prototype.start=async function(){return this;};
  AppServer.prototype.respond=function(...args){responses.push(args);return true;};
  AppServer.prototype.request=async function(method,p={}){
   if(method==='account/read')return {account:{type:'chatgpt',email:'synthetic@example.test',planType:'plus'}};
   if(method==='account/rateLimits/read')return {rateLimits:{primary:{usedPercent:10,windowDurationMins:300,resetsAt:Date.now()/1000+3600}}};
   if(method==='model/list')return {data:[{model:'synthetic-model',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};
   if(method==='config/read')return {config:{model:'synthetic-model',model_reasoning_effort:'medium'}};
   if(method==='thread/start'){threads++;threadConfigs.push(p.config);return {thread:{id:threads===1?'synthetic-mcp-chat':'synthetic-ordinary-chat-'+threads,cwd:p.cwd},model:'synthetic-model',reasoningEffort:'medium'};}
   if(method==='turn/start'){turns++;assert.equal(p.approvalPolicy,'on-request');if(p.outputSchema)assert.equal(p.outputSchema.type,'object');return {turn:{id:'synthetic-turn-'+turns}};}
   if(method==='turn/interrupt'){this.emit('notification',{method:'turn/completed',params:{threadId:p.threadId,turn:{id:p.turnId,status:'interrupted'}}});return {};}
   // Finished MCP threads are unsubscribed; the next continuation resumes the same thread.
   if(method==='thread/unsubscribe'){unsubscribed++;return {status:'unsubscribed'};}
   if(method==='thread/resume'){resumed++;threadConfigs.push(p.config);return {thread:{id:p.threadId,cwd:vscode.workspace.workspaceFolders[0].uri.fsPath},model:'synthetic-model',reasoningEffort:'medium'};}
   if(method==='thread/turns/list' || method==='thread/items/list')return {data:[]};
   return {};
  };
  await assert.rejects(vscode.workspace.getConfiguration('rundix').update('mcpService','service',vscode.ConfigurationTarget.Workspace));
  api=await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();
  assert.equal(api.mcp.panelSnapshot().serviceMode,undefined,'Workspace service setting cannot change the default window owner');
  registration=api.connections.registerProvider('synthetic.companion',{id:'synthetic-pool',label:'Synthetic pool',authenticate:async()=>{authenticated++;},configure:async()=> 'activate',prepareTurn:async({assertCanChange,reconnect})=>{
   assertCanChange();prepared++;
   if(prepareFailure){prepareFailure=false;throw Object.assign(Error('Synthetic quota rotation pending'),{retryable:true});}
   if(quotaWait){quotaWait=false;await reconnect();return {waitUntil:1};}
  },waitForReset:async()=>afterWait()});
  await api.connections.configure('synthetic-pool');
  await vscode.workspace.getConfiguration('rundix').update('mcpThreadConfig',{mcp_servers:{synthetic_helper:{enabled:false}}},vscode.ConfigurationTarget.Global);
  descriptor=await api.mcp.start();
  await api.mcp.connectPool();assert.equal(api.mcp.panelSnapshot().connected,true);
  const args={requestId:'synthetic-host-submit',description:'Synthetic task',projectDirectory:vscode.workspace.workspaceFolders[0].uri.fsPath,acceptanceCriteria:'Synthetic checks pass'};
  assert.deepEqual((await request(descriptor,'list_models',{})).models.map(m=>m.model),['synthetic-model'],'list_models reads the real catalog');
  const first=await request(descriptor,'submit_task',args);assert.equal(first.state,'queued');
  await wait(()=>turns===1);
  let s=[...api.sessions.values()].find(s=>s.id==='synthetic-mcp-chat');assert(s);assert(prepared>0);assert(authenticated>0);
  stage='chat-panel-entry';await api.dispatch(api.view(s).host,{action:'mcpPanel',sessionKey:s.key,currentDraft:'Synthetic preserved chat draft'});
  mcpEditor=api.mcp.openPanel();assert.equal(api.mcp.openPanel(),mcpEditor);assert.equal(s.draft,'Synthetic preserved chat draft');
  assert(mcpEditor.webview.html.includes('mcp-panel.js'));assert(mcpEditor.webview.html.includes("default-src 'none'"));
  stage='inline-configuration';const inlineConfiguration=await api.mcp.panelAction({action:'configuration'});assert.equal(inlineConfiguration.configuration.mcpServers.rundix.args.at(-1),descriptor);
  stage='task-lifecycle';
  const ordinary=api.create({key:'synthetic-ordinary',cwd:args.projectDirectory,model:'synthetic-model',prefs:{access:'workspace'}});
  await assert.rejects(()=>api.handle(ordinary,{action:'send',text:'Synthetic conflicting edit'}));assert.equal(ordinary.id,null);assert.equal(turns,1);
  assert.equal((await request(descriptor,'submit_task',args)).taskId,first.taskId);assert.equal(turns,1);
  api.server().emit('request',{id:'synthetic-approval',method:'item/commandExecution/requestApproval',params:{threadId:s.id,command:'synthetic-check',availableDecisions:['accept','decline']}});
  await wait(async()=> (await request(descriptor,'get_task',{taskId:first.taskId})).state==='waiting_approval');
  await assert.rejects(request(descriptor,'reload_window',{}),error=>error.code==='task_active','No reload while a task runs');
  await request(descriptor,'continue_task',{requestId:'synthetic-answer',taskId:first.taskId,approval:{id:'synthetic-approval',decision:'accept'}});
  assert.equal(responses.at(-1)[1].decision,'accept');
  const finish=()=>{
   api.server().emit('notification',{method:'item/completed',params:{threadId:s.id,turnId:s.turnId,item:{id:'synthetic-report-'+turns,type:'agentMessage',text:JSON.stringify({result:'Synthetic success',changedFiles:['synthetic.js'],checks:['Synthetic check passed'],remainingIssues:[]})}}});
   api.server().emit('notification',{method:'turn/completed',params:{threadId:s.id,turn:{id:s.turnId,status:'completed'}}});
  };
  finish();
  const completed=await wait(async()=>{const t=await request(descriptor,'get_task',{taskId:first.taskId});return t.state==='completed'?t:null;});assert.equal(completed.report.result,'Synthetic success');
  assert.equal(api.mcp.panelSnapshot().tasks.find(task=>task.taskId===first.taskId).report.result,'Synthetic success');
  await api.mcp.panelAction({action:'continue',requestId:'synthetic-follow',taskId:first.taskId,clarification:'Synthetic follow-up'});
  await wait(()=>turns===2);assert.equal(threads,1);assert.equal(s.id,completed.chatId);assert.equal(prepared,2);assert.equal(unsubscribed,1,'The finished task thread was released');assert.ok(resumed>=1,'The continuation resumed the released thread');assert.ok(threadConfigs.length>=2 && threadConfigs.every(c=>JSON.stringify(c)===JSON.stringify({mcp_servers:{synthetic_helper:{enabled:false}}})),'mcpThreadConfig reaches thread/start and thread/resume');
  await api.mcp.panelAction({action:'cancel',requestId:'synthetic-stop',taskId:first.taskId});
  await wait(async()=> (await request(descriptor,'get_task',{taskId:first.taskId})).state==='cancelled');
  await api.mcp.stop();
  assert.equal(api.mcp.panelSnapshot().bridgeRunning,false);assert.equal(api.mcp.panelSnapshot().tasks[0].chatId,completed.chatId);
  descriptor=await api.mcp.start();assert.equal((await request(descriptor,'get_task',{taskId:first.taskId})).chatId,completed.chatId);assert.equal(turns,2);
  stage='quota-error-continuation';
  await request(descriptor,'continue_task',{requestId:'synthetic-before-limit',taskId:first.taskId,clarification:'Synthetic before limit'});
  stage='quota-before-limit-start';
  await wait(()=>turns===3 && !s.sendingTask);
  api.server().emit('notification',{method:'turn/completed',params:{threadId:s.id,turn:{id:s.turnId,status:'failed',error:{message:'Synthetic usage limit reached'}}}});
  stage='quota-error-state';await wait(async()=>(await request(descriptor,'get_task',{taskId:first.taskId})).state==='error');
  await api.handle(s,{action:'draft',text:''});
  const closedSession=s;
  assert.equal((await request(descriptor,'close_task',{taskId:first.taskId})).chatClosed,true);
  assert.equal(api.sessions.has(closedSession.key),false,'close_task unloads the finished session');
  prepareFailure=true;quotaWait=true;
  await request(descriptor,'continue_task',{requestId:'synthetic-after-rotation',taskId:first.taskId,clarification:'Synthetic rotation clarification'});
  stage='quota-rotated-start';await wait(()=>turns===4 && api.sessions.get(closedSession.key) && !api.sessions.get(closedSession.key).sendingTask);
  s=api.sessions.get(closedSession.key);
  assert.notEqual(s,closedSession);assert(api.view(s).panel,'continue_task reopens the closed task chat');
  stage='quota-rotated-draft';
  assert.equal(s.draft,'','Sent continuation after retry and reconnect consumes the restored draft');
  assert.equal(api.store.session(s.key).draft,'');
  finish();await wait(async()=>(await request(descriptor,'get_task',{taskId:first.taskId})).state==='completed');
  stage='ordinary-rotation-drafts';
  quotaWait=true;afterWait=async()=>{await api.handle(ordinary,{action:'draft',text:'Synthetic newer ordinary draft'});return true;};
  await api.handle(ordinary,{action:'send',text:'Synthetic ordinary rotation input'});
  assert.equal(ordinary.draft,'Synthetic newer ordinary draft','Ordinary rotation preserves edits while awaiting reset');
  assert.equal(api.store.session(ordinary.key).draft,ordinary.draft);
  api.server().emit('notification',{method:'turn/completed',params:{threadId:ordinary.id,turn:{id:ordinary.turnId,status:'completed'}}});
  quotaWait=true;afterWait=async()=>false;
  await assert.rejects(api.handle(ordinary,{action:'send',text:'Synthetic cancelled rotation input'}));
  assert.equal(ordinary.draft,'Synthetic cancelled rotation input','Unsent ordinary input remains recoverable');
  quotaWait=true;afterWait=async()=>true;
  await api.handle(ordinary,{action:'send',text:'Synthetic ordinary successful retry'});
  assert.equal(ordinary.draft,'');
  api.server().emit('notification',{method:'turn/completed',params:{threadId:ordinary.id,turn:{id:ordinary.turnId,status:'completed'}}});
  report.rotationDrafts=true;report.closedContinuationReopened=true;
  report.passed=true;report.sameChatContinuation=true;report.companionPrepareCalls=prepared;report.approvalAndCancellation=true;report.persistedRestart=true;
 }catch{report.passed=false;report.failure='Synthetic MCP Extension Host scenario failed.';report.stage=stage;throw Error(report.failure);}
 finally{mcpEditor?.dispose();try{await api?.mcp.stop();}catch{}registration?.dispose();Object.assign(AppServer.prototype,original);fs.writeFileSync(path.join(__dirname,'../.verification/mcp-host.json'),JSON.stringify(report,null,2));}
};
