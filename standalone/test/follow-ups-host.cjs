const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
exports.run=async()=>{
 const report={inferencePerformed:false};let api,s,id,original,client;
 try{
  api=await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();s=api.create();await api.connect();client=api.server();
  const started=await client.request('thread/start',{cwd:vscode.workspace.workspaceFolders[0].uri.fsPath,sandbox:'read-only',approvalPolicy:'on-request',ephemeral:false});
  id=started.thread.id;s.id=id;s.cwd=started.thread.cwd;s.loaded=true;s.model=started.model;s.effort=started.reasoningEffort;
  await client.request('thread/name/set',{threadId:id,name:'Follow-up fixture'});
  await assert.rejects(client.request('turn/steer',{threadId:id,expectedTurnId:'no-active-turn',input:[{type:'text',text:'Protocol check only'}]}),/no active turn/i);report.nativeSteerMethod=true;
  const requests=[];let sequence=0,refuse=false;
  original=client.request.bind(client);
  client.request=async(method,params,...rest)=>{
    if(method==='account/read')return {account:{type:'chatgpt',email:'fixture@example.test',planType:'plus'}};
    if(method==='account/rateLimits/read')return {rateLimits:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:Date.now()/1000+3600},secondary:{usedPercent:20,windowDurationMins:10080,resetsAt:Date.now()/1000+86400}}};
    // This fixture never runs inference, so it has no paginated model rollout to load.
    if(method==='thread/resume')return original(method,{threadId:params.threadId});
    if(method==='thread/items/list')return {data:[],nextCursor:null};
    if(method==='turn/steer'){
      requests.push({method,params});assert.equal(params.expectedTurnId,s.turnId);assert.equal(params.threadId,id);
      if(refuse)throw Error('No active turn');
      client.emit('notification',{method:'item/completed',params:{threadId:id,turnId:s.turnId,item:{id:'steered-'+sequence++,type:'userMessage',content:params.input}}});
      return {turnId:s.turnId};
    }
    if(method==='turn/start'){
      requests.push({method,params});const turnId='fixture-'+sequence++;
      client.emit('notification',{method:'turn/started',params:{threadId:id,turn:{id:turnId}}});return {turn:{id:turnId}};
    }
    if(method==='turn/interrupt'){requests.push({method,params});return {};}
    return original(method,params,...rest);
  };
  const mockedRequest=client.request;
  s.busy=true;s.turnId='active-fixture';
  s.attachments=[{id:'selection-fixture',kind:'selection',path:'fixture.js',text:'const example = 1;'}];
  await api.handle(s,{action:'send',text:'Clarify the current task'});
  assert.equal(s.followUps.length,1);await api.handle(s,{action:'steerQueued',id:s.followUps[0].id});
  assert.equal(requests.at(-1).method,'turn/steer');assert.equal(requests.at(-1).params.input.length,2);assert.equal(s.attachments.length,0);assert.equal(s.busy,true);assert.equal(s.draft,'');report.steersWithoutInterrupt=true;
  await api.handle(s,{action:'enqueue',text:'Next task'});
  assert.equal(s.followUps.length,1);assert.equal(api.store.session(s.key).followUps.length,1);report.queuePersisted=true;
  await api.handle(s,{action:'enqueue',text:'Remove this'});await api.handle(s,{action:'removeQueued',id:s.followUps.at(-1).id});assert.equal(s.followUps.length,1);
  await api.handle(s,{action:'enqueue',text:'After next task'});
  client.emit('notification',{method:'turn/completed',params:{threadId:id,turn:{id:s.turnId,status:'completed',error:null}}});
  for(let count=0;count<200 && (s.followUps.length===2 || s.followUpSending);count++)await delay(25);
  if(s.error)throw Error(s.error);
  assert.equal(s.followUps.length,1);assert.equal(requests.at(-1).method,'turn/start');assert.equal(requests.at(-1).params.input[0].text,'Next task');
  client.emit('notification',{method:'turn/completed',params:{threadId:id,turn:{id:s.turnId,status:'completed',error:null}}});
  for(let count=0;count<200 && (s.followUps.length || s.followUpSending);count++)await delay(25);
  assert.equal(s.followUps.length,0);assert.equal(requests.at(-1).params.input[0].text,'After next task');report.autoStartsQueuedTask=true;
  await api.handle(s,{action:'enqueue',text:'Keep after stop'});await api.handle(s,{action:'stop'});
  client.emit('notification',{method:'turn/completed',params:{threadId:id,turn:{id:s.turnId,status:'interrupted',error:null}}});await delay(100);
  assert.equal(s.followUps.length,1);assert.equal(s.busy,false);report.stopKeepsQueue=true;
  await api.handle(s,{action:'sendQueued'});assert.equal(s.followUps.length,0);assert.equal(s.busy,true);
  refuse=true;await api.handle(s,{action:'send',text:'Race with completion'});await api.handle(s,{action:'steerQueued',id:s.followUps[0].id});assert.equal(s.followUps.length,1);assert.equal(s.draft,'');report.refusedSteerRetained=true;
  await api.handle(s,{action:'removeQueued',id:s.followUps[0].id});
  client.request=async(method,params,...rest)=>{if(method==='turn/steer')throw Error('Network timeout');return original(method,params,...rest);};
  await api.handle(s,{action:'send',text:'Preserve ambiguous input'});
  await assert.rejects(api.handle(s,{action:'steerQueued',id:s.followUps[0].id}),/timeout/);assert.equal(s.followUps[0].text,'Preserve ambiguous input');assert.equal(s.followUps[0].deliveryUncertain,true);report.ambiguousFailureKeepsQueuedMessage=true;
  await api.handle(s,{action:'removeQueued',id:s.followUps[0].id});
  client.emit('notification',{method:'turn/completed',params:{threadId:id,turn:{id:s.turnId,status:'interrupted',error:null}}});
  const count=requests.filter(request=>request.method==='turn/start').length;
  client.request=async(method,params,...rest)=>method==='account/rateLimits/read'?{rateLimits:{limitId:'codex',primary:{usedPercent:100,windowDurationMins:300,resetsAt:Date.now()/1000+3600}}}:mockedRequest(method,params,...rest);
  await assert.rejects(api.handle(s,{action:'send',text:'Keep exhausted local account draft'}),/limits|лимит/i);
  assert.equal(requests.filter(request=>request.method==='turn/start').length,count);assert.equal(s.draft,'Keep exhausted local account draft');report.singleLocalExhaustionBlocksSend=true;
  s.busy=false;report.passed=true;
 }catch(error){report.passed=false;report.failure=String(error.message).slice(0,250);}
 finally{
  if(client&&original)client.request=original;
  if(id&&client)try{await client.request('thread/delete',{threadId:id});}catch{}
  if(s){s.busy=false;api.view(s).panel?.dispose();}
  fs.mkdirSync(path.join(__dirname,'../.verification'),{recursive:true});fs.writeFileSync(path.join(__dirname,'../.verification/follow-ups-host.json'),JSON.stringify(report,null,2));
 }
 if(!report.passed)throw Error('Follow-up integration check failed');
};
