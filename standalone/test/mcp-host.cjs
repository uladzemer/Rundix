const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {AppServer,findCli}=require('../runtime/transport.cjs');
const {request}=require('../runtime/mcp-bridge.cjs');
exports.run=async()=>{
 const report={syntheticTransport:true,syntheticCompanion:true,inferencePerformed:false};
 const original={start:AppServer.prototype.start,request:AppServer.prototype.request,respond:AppServer.prototype.respond};
 let mcpEditor;
 let api,registration,descriptor,stage='initialization';let turns=0,threads=0,prepared=0,authenticated=0;const responses=[];
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
   if(method==='thread/start'){threads++;return {thread:{id:'synthetic-mcp-chat',cwd:p.cwd},model:'synthetic-model',reasoningEffort:'medium'};}
   if(method==='turn/start'){turns++;assert.equal(p.approvalPolicy,'on-request');assert.equal(p.outputSchema.type,'object');return {turn:{id:'synthetic-turn-'+turns}};}
   if(method==='turn/interrupt'){this.emit('notification',{method:'turn/completed',params:{threadId:p.threadId,turn:{id:p.turnId,status:'interrupted'}}});return {};}
   return {};
  };
  api=await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();
  registration=api.connections.registerProvider('synthetic.companion',{id:'synthetic-pool',label:'Synthetic pool',authenticate:async()=>{authenticated++;},configure:async()=> 'activate',prepareTurn:async({assertCanChange})=>{assertCanChange();prepared++;}});
  await api.connections.configure('synthetic-pool');
  descriptor=await api.mcp.start();
  await api.mcp.connectPool();assert.equal(api.mcp.panelSnapshot().connected,true);
  const args={requestId:'synthetic-host-submit',description:'Synthetic task',projectDirectory:vscode.workspace.workspaceFolders[0].uri.fsPath,acceptanceCriteria:'Synthetic checks pass'};
  const first=await request(descriptor,'submit_task',args);assert.equal(first.state,'queued');
  await wait(()=>turns===1);
  const s=[...api.sessions.values()].find(s=>s.id==='synthetic-mcp-chat');assert(s);assert(prepared>0);assert(authenticated>0);
  stage='chat-panel-entry';await api.dispatch(s.host,{action:'mcpPanel',sessionKey:s.key,currentDraft:'Synthetic preserved chat draft'});
  mcpEditor=api.mcp.openPanel();assert.equal(api.mcp.openPanel(),mcpEditor);assert.equal(s.draft,'Synthetic preserved chat draft');
  assert(mcpEditor.webview.html.includes('mcp-panel.js'));assert(mcpEditor.webview.html.includes("default-src 'none'"));
  stage='inline-configuration';const inlineConfiguration=await api.mcp.panelAction({action:'configuration'});assert.equal(inlineConfiguration.configuration.mcpServers.rundix.args.at(-1),descriptor);
  stage='task-lifecycle';
  const ordinary=api.create({key:'synthetic-ordinary',cwd:args.projectDirectory,model:'synthetic-model',prefs:{access:'workspace'}});
  await assert.rejects(()=>api.handle(ordinary,{action:'send',text:'Synthetic conflicting edit'}));assert.equal(ordinary.id,null);assert.equal(turns,1);
  assert.equal((await request(descriptor,'submit_task',args)).taskId,first.taskId);assert.equal(turns,1);
  api.server().emit('request',{id:'synthetic-approval',method:'item/commandExecution/requestApproval',params:{threadId:s.id,command:'synthetic-check',availableDecisions:['accept','decline']}});
  await wait(async()=> (await request(descriptor,'get_task',{taskId:first.taskId})).state==='waiting_approval');
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
  await wait(()=>turns===2);assert.equal(threads,1);assert.equal(s.id,completed.chatId);assert.equal(prepared,2);
  await api.mcp.panelAction({action:'cancel',requestId:'synthetic-stop',taskId:first.taskId});
  await wait(async()=> (await request(descriptor,'get_task',{taskId:first.taskId})).state==='cancelled');
  await api.mcp.stop();
  assert.equal(api.mcp.panelSnapshot().bridgeRunning,false);assert.equal(api.mcp.panelSnapshot().tasks[0].chatId,completed.chatId);
  descriptor=await api.mcp.start();assert.equal((await request(descriptor,'get_task',{taskId:first.taskId})).chatId,completed.chatId);assert.equal(turns,2);
  report.passed=true;report.sameChatContinuation=true;report.companionPrepareCalls=prepared;report.approvalAndCancellation=true;report.persistedRestart=true;
 }catch{report.passed=false;report.failure='Synthetic MCP Extension Host scenario failed.';report.stage=stage;throw Error(report.failure);}
 finally{mcpEditor?.dispose();try{await api?.mcp.stop();}catch{}registration?.dispose();Object.assign(AppServer.prototype,original);fs.writeFileSync(path.join(__dirname,'../.verification/mcp-host.json'),JSON.stringify(report,null,2));}
};
