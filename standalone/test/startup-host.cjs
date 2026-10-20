const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {AppServer,findCli}=require('../runtime/transport.cjs');
exports.run=async()=>{
 const report={syntheticTransport:true,inferencePerformed:false};
 const original={start:AppServer.prototype.start,request:AppServer.prototype.request,respond:AppServer.prototype.respond,home:process.env.CODEX_HOME};
 const counts={},inputs=[],turnSettings=[];let api,s,modelResolve,configResolve,timer,originalPost;
 const published=[];
 try{
  await vscode.workspace.getConfiguration('rundix').update('cliPath',findCli(),vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration('rundix').update('cliAutoUpdate',false,vscode.ConfigurationTarget.Global);
  process.env.CODEX_HOME=path.join(__dirname,'../.verification/startup-empty-home');
  fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
  AppServer.prototype.start=async function(){return this;};
  AppServer.prototype.request=async function(method,p={}){
   counts[method]=(counts[method]||0)+1;
   if(['turn/start','turn/steer'].includes(method))inputs.push(p.input?.[0]?.text);
   if(method==='account/read')return {account:{type:'chatgpt',email:'fixture@example.test',planType:'plus'}};
   if(method==='account/rateLimits/read')return {rateLimits:{primary:{usedPercent:10,windowDurationMins:300,resetsAt:Date.now()/1000+3600}}};
   if(method==='model/list'||method==='config/read'){
    return new Promise((resolve,reject)=>{
     if(method==='model/list')modelResolve=resolve;else configResolve=resolve;
     timer ||= setTimeout(()=>reject(Error('Catalog/config requests did not overlap')),1000);
     if(modelResolve&&configResolve){
      clearTimeout(timer);timer=null;
      modelResolve({data:[{model:'fixture',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]},{model:'fixture-next',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],nextCursor:null});
      configResolve({config:{model:'fixture',model_reasoning_effort:'medium'}});
     }
    });
   }
   if(method==='thread/start')return {thread:{id:'startup-thread',cwd:process.cwd()},model:'fixture',reasoningEffort:'medium'};
   if(method==='turn/start'){
    turnSettings.push({model:p.model,effort:p.effort,settings:p.collaborationMode.settings,sandboxPolicy:p.sandboxPolicy,approvalPolicy:p.approvalPolicy,outputSchema:p.outputSchema});
    assert.match(p.collaborationMode.settings.developer_instructions,/request_user_input|explicitly approved task/);
    return {turn:{id:'startup-turn'}};
   }
   return {};
  };
  api=await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();s=api.create();
  originalPost=api.view(s).panel.webview.postMessage;
  api.view(s).panel.webview.postMessage=async function(message){published.push(message);return originalPost.call(this,message);};
  await api.handle(s,{action:'send',text:'Synthetic first message'});
  report.coldCounts={...counts};
  assert.equal(counts['account/read'],1,'Cold account reads');assert.equal(counts['account/rateLimits/read'],1,'Cold quota reads');
  assert.equal(counts['model/list'],1);assert.equal(counts['turn/start'],1);assert.equal(s.busy,true);
  report.parallelCatalogAndConfig=true;report.singleColdAccountRead=true;report.singleQuotaRead=true;
  api.server().emit('notification',{method:'turn/completed',params:{threadId:s.id,turn:{id:s.turnId,status:'interrupted'}}});
  s.prefs.focus=true;
  await api.handle(s,{action:'send',text:'Synthetic next message'});
  assert.match(turnSettings.at(-1).settings.developer_instructions,/Before using tools for a task.*commentary/);
  s.prefs.focus=false;
  assert.equal(counts['account/read'],2);assert.equal(counts['account/rateLimits/read'],2);assert.equal(counts['model/list'],1);
  report.warmSendStillChecksAccountAndQuotas=true;report.passed=true;
  assert.deepEqual(api.server().configArgs,['-c','features.default_mode_request_user_input=true']);
  const replies=[];AppServer.prototype.respond=function(...args){replies.push(args);return true;};
  api.server().emit('request',{id:'quiz-fixture',method:'item/tool/requestUserInput',params:{threadId:s.id,questions:[{id:'choice',question:'Choose a mode',options:[{label:'Review (Recommended)',description:'Read only'}]},{id:'notes',question:'Details'}]}});
  await assert.rejects(api.handle(s,{action:'answer',id:'quiz-fixture',answers:{choice:'Review (Recommended)'}}));
  assert.equal(replies.length,0);
  await api.handle(s,{action:'answer',id:'quiz-fixture',answers:{choice:'Review (Recommended)',notes:'Keep this project'}});
  assert.deepEqual(replies[0],['quiz-fixture',{answers:{choice:{answers:['Review (Recommended)']},notes:{answers:['Keep this project']}}}]);
  report.nativeQuestionResponseShape=true;report.defaultModeQuestionFlag=true;
  assert.equal(api.store.session(s.key).questionHistory[0].answers.choice,'Review (Recommended)');
  api.server().emit('request',{id:'quiz-skip',method:'item/tool/requestUserInput',params:{threadId:s.id,questions:[{id:'choice',question:'Continue?',options:[{label:'Recommended'}]}]}});
  await api.handle(s,{action:'answer',id:'quiz-skip',skip:true});
  assert.deepEqual(replies.at(-1),['quiz-skip',{answers:{choice:{answers:[]}}}]);
  assert.equal(api.store.session(s.key).questionHistory.at(-1).skipped,true);
  api.server().emit('request',{id:'quiz-secret',method:'item/tool/requestUserInput',params:{threadId:s.id,questions:[{id:'secret',question:'Private',isSecret:true}]}});
  await api.handle(s,{action:'answer',id:'quiz-secret',answers:{secret:'fixture-private-answer'}});
  assert.equal(JSON.stringify(api.store.session(s.key).questionHistory).includes('fixture-private-answer'),false);
  report.blockingSkipAndSafeHistory=true;
  const asyncItem={id:'call_async_fixture',type:'agentMessage',questions:[{title:'Choose a connection',options:['Local (Recommended)','Remote']}]};
  api.server().emit('notification',{method:'item/completed',params:{threadId:s.id,turnId:s.turnId,item:asyncItem}});
  for(let n=0;n<100 && !published.some(message=>message.type==='state'&&message.data.items.some(item=>item.id===asyncItem.id));n++)await new Promise(resolve=>setTimeout(resolve,10));
  const delivered=published.findLast(message=>message.type==='state'&&message.data.items.some(item=>item.id===asyncItem.id));
  assert.ok(delivered,'Host must publish the streamed item');
  assert.deepEqual(delivered.data.items.find(item=>item.id===asyncItem.id).questions,asyncItem.questions,'Question metadata must survive the real host/webview projection');
  assert.ok(delivered.data.questionHistory.some(record=>record.id==='b:quiz-fixture'&&record.answers.choice==='Review (Recommended)'),'Actual postMessage must contain saved answers');
  assert.equal(JSON.stringify(delivered.data.questionHistory).includes('fixture-private-answer'),false);
  report.actualWebviewMessageIncludesQuestions=true;
  fs.writeFileSync(path.join(__dirname,'../.verification/quiz-published-state.json'),JSON.stringify({items:delivered.data.items.filter(item=>item.id===asyncItem.id),questionHistory:delivered.data.questionHistory}));
  s.draft='Do not clear this draft';s.attachments=[{id:'keep-file',kind:'file',path:'C:/fixture/keep.js'}];
  await api.handle(s,{action:'answerAsync',itemId:asyncItem.id,answers:{'0':'Local (Recommended)'}});
  assert.equal(counts['turn/steer'],1);assert.equal(s.draft,'Do not clear this draft');assert.equal(s.attachments.length,1);
  assert.equal(s.asyncQuestionReplies[asyncItem.id],'sent');
  await assert.rejects(api.handle(s,{action:'answerAsync',itemId:asyncItem.id,answers:{'0':'Remote'}}));
  assert.equal(counts['turn/steer'],1);
  api.server().emit('notification',{method:'turn/completed',params:{threadId:s.id,turn:{id:s.turnId,status:'interrupted'}}});
  s.items.push({...asyncItem,id:'call_idle_fixture'});
  await api.handle(s,{action:'answerAsync',itemId:'call_idle_fixture',answers:{'0':'Remote'}});
  assert.equal(counts['turn/start'],3);assert.equal(s.draft,'Do not clear this draft');assert.equal(s.attachments.length,1);
  report.asyncQuestionRepliesPreserveDraft=true;report.asyncQuestionActiveAndIdlePaths=true;
  const requestBeforeRefusal=AppServer.prototype.request;
  AppServer.prototype.request=async function(method,params){
    if(method==='turn/steer')throw Error('no active turn');
    return requestBeforeRefusal.call(this,method,params);
  };
  s.items.push({...asyncItem,id:'call_queued_fixture'});
  await api.handle(s,{action:'answerAsync',itemId:'call_queued_fixture',answers:{'0':'Remote'}});
  assert.equal(s.asyncQuestionReplies.call_queued_fixture,'queued');assert.equal(s.followUps.length,1);
  await api.handle(s,{action:'removeQueued',id:s.followUps[0].id});
  assert.equal(s.asyncQuestionReplies.call_queued_fixture,undefined);assert.equal(s.followUps.length,0);
  report.cancelQueuedQuestionRestoresForm=true;
  AppServer.prototype.request=requestBeforeRefusal;
  s.items.push({...asyncItem,id:'call_skip_fixture'});
  await api.handle(s,{action:'answerAsync',itemId:'call_skip_fixture',skip:true});
  const skipReply=JSON.parse(inputs.at(-1).split('\n')[1]);
  assert.equal(skipReply[0].answer,require('../runtime/question-records.cjs').SKIPPED);
  assert.equal(api.store.session(s.key).questionHistory.at(-1).skipped,true);
  assert.equal(s.draft,'Do not clear this draft');assert.equal(s.attachments.length,1);
  report.asyncSkipNotARecommendedSelection=true;
  s.attachments=[];
  const steersBeforeQueue=counts['turn/steer'];
  await api.handle(s,{action:'send',text:'FIFO first'});
  s.attachments=[{id:'synthetic-queued-image',kind:'image',path:path.join(__dirname,'synthetic-queued-image.png')}];
  await api.handle(s,{action:'send',text:'FIFO second'});
  s.followUpSending=true;
  await api.handle(s,{action:'send',text:'FIFO third'});
  s.followUpSending=false;
  assert.deepEqual(s.followUps.map(item=>item.text),['FIFO first','FIFO second','FIFO third']);
  let editing=s.followUps[1];const selection=JSON.stringify(editing.modelSelection),queuedAttachments=JSON.stringify(editing.attachments);
  const edit={action:'editQueued',id:editing.id,expectedText:editing.text,text:'FIFO second edited',requestId:'synthetic-edit'};
  await api.handle(s,edit);editing=s.followUps[1];
  assert.deepEqual(s.followUps.map(item=>item.text),['FIFO first','FIFO second edited','FIFO third']);
  assert.equal(api.store.session(s.key).followUps[1].text,'FIFO second edited');
  assert.equal(JSON.stringify(editing.modelSelection),selection);
  assert.equal(JSON.stringify(editing.attachments),queuedAttachments);
  assert.equal(api.store.session(s.key).followUps[1].attachments[0].id,'synthetic-queued-image');
  const saveRecord=api.store.saveSession;
  api.store.saveSession=()=>{throw Error('Synthetic queue write failure');};
  try {
    await assert.rejects(api.handle(s,{...edit,expectedText:editing.text,text:'Must not replace the queued text'}));
  } finally { api.store.saveSession=saveRecord; }
  assert.equal(editing.text,'FIFO second edited');
  assert.equal(api.store.session(s.key).followUps[1].text,'FIFO second edited');
  const updateWorkspace=api.library.storage.update;
  api.library.storage.update=function(key,value){
    if(key==='session:'+s.key)return Promise.reject(Error('Synthetic secondary state failure'));
    return updateWorkspace.call(this,key,value);
  };
  try {
    await api.handle(s,{...edit,expectedText:editing.text,text:'FIFO second committed'});
  } finally { api.library.storage.update=updateWorkspace; }
  editing=s.followUps[1];
  assert.equal(editing.text,'FIFO second committed');
  assert.equal(api.store.session(s.key).followUps[1].text,'FIFO second committed');
  await assert.rejects(api.handle(s,edit),'A stale edit must not overwrite a newer value');
  s.followUpSending=true;
  await assert.rejects(api.handle(s,{...edit,expectedText:editing.text,text:'Too late'}));
  s.followUpSending=false;
  assert.equal(editing.text,'FIFO second committed');
  assert.ok(published.some(message=>message.type==='queuedEditResult'&&message.requestId==='synthetic-edit'&&message.ok));
  report.pendingEditPersistedWithoutReordering=true;
  assert.equal(counts['turn/steer'],steersBeforeQueue,'New sends must not bypass a queued message');
  for(const [index,text] of ['FIFO first','FIFO second committed','FIFO third'].entries()){
    api.server().emit('notification',{method:'turn/completed',params:{threadId:s.id,turn:{id:s.turnId,status:'completed'}}});
    for(let n=0;n<200 && (s.followUpSending || s.followUps.length!==2-index);n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(s.followUps.length,2-index);assert.equal(inputs.at(-1),text);
  }
  api.server().emit('notification',{method:'turn/completed',params:{threadId:s.id,turn:{id:s.turnId,status:'interrupted'}}});
  s.followUps=[{id:'older-idle',text:'Older idle task',attachments:[]}];
  await api.handle(s,{action:'send',text:'New idle task'});
  assert.equal(inputs.at(-1),'Older idle task');assert.equal(s.followUps[0].text,'New idle task');
  report.queuedSendsRemainFifo=true;
  const pending=s.followUps[0];
  const draft=s.draft; s.draft='Keep my independent draft';
  s.attachments=[{id:'keep-steer-draft',kind:'selection',path:'fixture.js',text:'synthetic'}];
  const steersBeforeExplicit=counts['turn/steer'] || 0;
  await api.handle(s,{action:'steerQueued',id:pending.id});
  assert.equal(counts['turn/steer'],steersBeforeExplicit+1);
  assert.equal(inputs.at(-1),'New idle task');assert.equal(s.followUps.length,0);
  assert.equal(s.draft,'Keep my independent draft');assert.equal(s.attachments.length,1);
  await api.handle(s,{action:'send',text:'Uncertain queued delivery'});
  const uncertain=s.followUps[0];const beforeTimeout=AppServer.prototype.request;
  AppServer.prototype.request=async function(method,params){if(method==='turn/steer')throw Error('Synthetic timeout');return beforeTimeout.call(this,method,params);};
  await assert.rejects(api.handle(s,{action:'steerQueued',id:uncertain.id}),/timeout/);
  assert.equal(uncertain.deliveryUncertain,true);assert.equal(s.followUpSending,false);
  AppServer.prototype.request=beforeTimeout;
  api.server().emit('notification',{method:'turn/completed',params:{threadId:s.id,turn:{id:s.turnId,status:'interrupted'}}});
  const startsBeforeUncertain=counts['turn/start'];
  await assert.rejects(api.handle(s,{action:'sendQueued'}));
  assert.equal(counts['turn/start'],startsBeforeUncertain);assert.equal(s.followUps[0].id,uncertain.id);
  report.explicitSteerAndUncertainDelivery=true;s.draft=draft;
  await api.handle(s,{action:'removeQueued',id:uncertain.id});
  s.busy=true;s.turnId='model-selection-active';s.turnModel='fixture';
  const settingsUpdates=counts['thread/settings/update'] || 0;
  await api.handle(s,{action:'settings',model:'fixture-next'});
  assert.equal(s.model,'fixture-next');assert.equal(s.effort,'high');
  assert.equal(counts['thread/settings/update'] || 0,settingsUpdates,'Selecting a future model must not mutate the active thread');
  api.server().emit('notification',{method:'thread/tokenUsage/updated',params:{threadId:s.id,tokenUsage:{last:{totalTokens:10},modelContextWindow:1000}}});
  assert.equal(s.usageModel,'fixture','Active usage still belongs to the executing model');
  await api.handle(s,{action:'send',text:'Next model B'});
  await api.handle(s,{action:'settings',model:'fixture'});
  await api.handle(s,{action:'send',text:'Then model A'});
  assert.deepEqual(s.followUps.map(item=>item.modelSelection.model),['fixture-next','fixture']);
  s.followUps=JSON.parse(JSON.stringify(api.store.session(s.key).followUps));
  await api.handle(s,{action:'settings',model:'fixture-next'});
  for(const [index,expected] of [{model:'fixture-next',effort:'high'},{model:'fixture',effort:'medium'}].entries()){
    api.server().emit('notification',{method:'turn/completed',params:{threadId:s.id,turn:{id:s.turnId,status:'completed'}}});
    for(let n=0;n<200 && (s.followUpSending || s.followUps.length!==1-index);n++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(s.followUps.length,1-index);
    assert.equal(turnSettings.at(-1).model,expected.model);assert.equal(turnSettings.at(-1).effort,expected.effort);
    assert.equal(turnSettings.at(-1).settings.model,expected.model);
    assert.equal(s.model,'fixture-next','Dispatching an older queued selection must not replace the composer selection');
  }
  await api.handle(s,{action:'send',text:'Unavailable queued model'});
  s.followUps[0].modelSelection.model='missing-fixture';
  api.server().emit('notification',{method:'turn/completed',params:{threadId:s.id,turn:{id:s.turnId,status:'interrupted'}}});
  const startsBeforeMissing=counts['turn/start'];
  await assert.rejects(api.handle(s,{action:'sendQueued'}));
  assert.equal(counts['turn/start'],startsBeforeMissing);assert.equal(s.followUps.length,1);
  report.queuedModelsAreSnapshots=true;
  await require('./preflight-host-checks.cjs')({api,s,counts,turnSettings});
  report.preflightRequiresExplicitCurrentApproval=true;
  await require('./queue-management-host-checks.cjs')({api,s,counts,inputs});
  report.queueAttachmentsOrderPauseAndManualDispatch=true;
 }catch(error){report.passed=false;report.error=String(error.message).slice(0,300);}
 finally{
  clearTimeout(timer);if(api?.view(s)?.panel&&originalPost)api.view(s).panel.webview.postMessage=originalPost;api?.view(s)?.panel?.dispose();Object.assign(AppServer.prototype,{start:original.start,request:original.request,respond:original.respond});
  if(original.home===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=original.home;
  fs.writeFileSync(path.join(__dirname,'../.verification/startup-host.json'),JSON.stringify(report,null,2));
 }
 if(!report.passed)throw Error(report.error);
};
