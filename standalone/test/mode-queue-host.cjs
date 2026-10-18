const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.run=async()=>{
 const report={inferencePerformed:false};let api,s,id;
 try{
  api=await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();s=api.create();
  assert.equal(require('../ui/modes.js').current(s.prefs).id,'workspace');report.projectDefault=true;
  await api.connect();
  const started=await api.server().request('thread/start',{cwd:vscode.workspace.workspaceFolders[0].uri.fsPath,sandbox:'workspace-write',approvalPolicy:'on-request',ephemeral:false});
  id=started.thread.id;s.id=id;s.loaded=true;s.model=started.model;s.effort=started.reasoningEffort;
  await api.server().request('thread/name/set',{threadId:id,name:'Deferred permissions fixture'});
  const models=(await api.server().request('model/list',{limit:100})).data,model=models.find(model=>model.model===s.model)||models[0];
  s.model=model.model;s.effort=model.defaultReasoningEffort;
  await api.server().request('thread/settings/update',{threadId:id,model:s.model,effort:s.effort});
  await api.handle(s,{action:'mode',mode:'workspace'});
  s.busy=true;await api.handle(s,{action:'mode',mode:'full'});
  assert.equal(s.prefs.access,'workspace');assert.equal(s.prefs.pendingMode,'full');report.queuedDuringTask=true;
  await api.handle(s,{action:'mode',mode:'workspace'});assert.equal(s.prefs.pendingMode,null);report.cancelPending=true;
  await api.handle(s,{action:'mode',mode:'full'});
  api.server().emit('notification',{method:'turn/completed',params:{threadId:id,turn:{id:'fixture-turn',status:'interrupted',error:null}}});
  for(let count=0;count<200 && (s.prefs.pendingMode||s.modeChange);count++)await new Promise(resolve=>setTimeout(resolve,25));
  report.afterCompletion={pending:s.prefs.pendingMode,busy:s.busy,access:s.prefs.access,error:!!s.error};
  assert.equal(s.prefs.pendingMode,null);assert.equal(s.prefs.access,'full');
  const effective=await api.server().request('thread/resume',{threadId:id});
  assert.equal(effective.sandbox.type,'dangerFullAccess');assert.equal(effective.approvalPolicy,'never');
  report.appliedAfterInterruptedTurn=true;
  await api.handle(s,{action:'mode',mode:'workspace'});assert.equal(s.prefs.access,'workspace');report.passed=true;
 }catch(error){report.passed=false;report.failure=error.code || 'mode verification error';report.detail=String(error.message).slice(0,300);}
 finally{
  if(id&&api)try{await api.server().request('thread/delete',{threadId:id});}catch{}
  s?.panel?.dispose();fs.mkdirSync(path.join(__dirname,'../.verification'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../.verification/mode-queue-host.json'),JSON.stringify(report,null,2));
 }
 if(!report.passed)throw Error('Deferred mode verification failed');
};
