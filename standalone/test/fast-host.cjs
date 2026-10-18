const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fastTier}=require('../ui/speed.js');
exports.run=async()=>{
 const report={inferencePerformed:false};let api,s,client,id,original;
 try{
  await vscode.workspace.getConfiguration('rundix').update('cliAutoUpdate',false,vscode.ConfigurationTarget.Global);
  api=await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();s=api.create();await api.connect();client=api.server();
  await api.refreshCatalog();
  const model=(await client.request('model/list',{limit:100,includeHidden:false})).data.find(model=>!model.hidden && fastTier(model));assert.ok(model);
  report.model=model.model;report.catalogTier=fastTier(model);report.stage='draft toggle';
  s.model=model.model;s.effort=model.defaultReasoningEffort;
  await api.handle(s,{action:'fast',enabled:true});assert.equal(s.prefs.fast,true);assert.equal(api.store.session(s.key).prefs.fast,true);
  report.stage='native thread';
  const started=await client.request('thread/start',{model:s.model,serviceTier:fastTier(model),cwd:vscode.workspace.workspaceFolders[0].uri.fsPath,sandbox:'read-only',approvalPolicy:'on-request',ephemeral:false});
  id=started.thread.id;s.id=id;s.cwd=started.thread.cwd;s.loaded=true;
  assert.equal(started.serviceTier,fastTier(model));report.nativeThreadFast=true;
  await client.request('thread/name/set',{threadId:id,name:'Fast protocol verification'});
  await api.handle(s,{action:'fast',enabled:false});
  assert.ok([null,'default'].includes((await client.request('thread/resume',{threadId:id})).serviceTier));report.nativeStandardRestored=true;
  await api.handle(s,{action:'fast',enabled:true});
  assert.equal((await client.request('thread/resume',{threadId:id})).serviceTier,fastTier(model));report.nativeSettingsFast=true;
  s.busy=true;await assert.rejects(api.handle(s,{action:'fast',enabled:false}));s.busy=false;assert.equal(s.prefs.fast,true);report.busyGuard=true;
  const sent=[];original=client.request.bind(client);
  client.request=async(method,params,...rest)=>{
   if(method==='account/read')return {account:{type:'chatgpt',email:'fixture@example.test',planType:'plus'}};
   if(method==='turn/start'){
    sent.push(params);const turnId='fast-fixture-'+sent.length;
    client.emit('notification',{method:'turn/started',params:{threadId:id,turn:{id:turnId}}});return {turn:{id:turnId}};
   }
   return original(method,method==='thread/resume'?{threadId:params.threadId}:params,...rest);
  };
  await api.handle(s,{action:'send',text:'Synthetic Fast request; never sent for inference'});
  assert.equal(sent.at(-1).serviceTierForTurn,fastTier(model));report.fastTurnParameter=true;
  client.emit('notification',{method:'turn/completed',params:{threadId:id,turn:{id:s.turnId,status:'interrupted',error:null}}});
  await api.handle(s,{action:'fast',enabled:false});
  await api.handle(s,{action:'send',text:'Synthetic Standard request; never sent for inference'});
  assert.equal(sent.at(-1).serviceTierForTurn,'default');report.standardTurnParameter=true;
  client.emit('notification',{method:'turn/completed',params:{threadId:id,turn:{id:s.turnId,status:'interrupted',error:null}}});
  report.passed=true;
 }catch(error){report.passed=false;report.error=String(error.message).slice(0,300);}
 finally{
  if(original)client.request=original;
  if(id&&client)try{await client.request('thread/delete',{threadId:id});}catch{}
  s?.panel?.dispose();fs.writeFileSync(path.join(__dirname,'../.verification/fast-host.json'),JSON.stringify(report,null,2));
 }
 if(!report.passed)throw Error(report.error);
};
