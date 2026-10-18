const {AppServer}=require('../runtime/transport.cjs');const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs');
(async()=>{
 const s=new AppServer();let id;const dir=path.resolve(__dirname,'../.verification/live-fixture');fs.mkdirSync(dir,{recursive:true});
 try{
  await s.start();const account=await s.request('account/read',{refreshToken:false});
  const models=await s.request('model/list',{limit:100});assert.ok(models.data.length);
  const result=await s.request('thread/start',{cwd:dir,ephemeral:false,sandbox:'read-only',approvalPolicy:'on-request'});id=result.thread.id;
  await s.request('thread/name/set',{threadId:id,name:'Workbench integration fixture'});
  const model=models.data.find(m=>m.model===result.model)||models.data[0],effort=model.supportedReasoningEfforts[0].reasoningEffort;
  await s.request('thread/settings/update',{threadId:id,model:model.model,effort});
  const resumed=await s.request('thread/resume',{threadId:id,excludeTurns:true});assert.equal(resumed.model,model.model);assert.equal(resumed.reasoningEffort,effort);
  const items=await s.request('thread/items/list',{threadId:id,limit:200,sortDirection:'desc'});assert.equal(items.data.length,0);
  let answer='';
  if(process.argv.includes('--turn')){
   let complete;const finished=new Promise((resolve,reject)=>{complete=resolve;const timer=setTimeout(()=>reject(Error('Inference timeout')),120000);s.on('notification',m=>{if(m.params?.threadId!==id)return;if(m.method==='item/agentMessage/delta')answer+=m.params.delta;if(m.method==='turn/completed'){clearTimeout(timer);m.params.turn.error?reject(Error(m.params.turn.error.message)):resolve();}});});
   await s.request('turn/start',{threadId:id,input:[{type:'text',text:'Reply exactly WORKBENCH_OK. Do not use tools or modify files.'}],model:model.model,effort,sandboxPolicy:{type:'readOnly'},approvalPolicy:'on-request'});await finished;assert.match(answer,/WORKBENCH_OK/);
  }
  console.log(JSON.stringify({connected:true,authenticated:!!account.account,authType:account.account?.type,models:models.data.length,createRenameResumeSettingsHistory:true,inferencePerformed:!!answer,streamedReplyVerified:!!answer}));
 }finally{if(id)await s.request('thread/delete',{threadId:id});s.dispose();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
