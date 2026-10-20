const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {connect}=require('../runtime/server-connection.cjs');
async function notification(method,optIn){
  let authenticate,entered;
  const gate=new Promise(resolve=>{authenticate=resolve;});
  const waiting=new Promise(resolve=>{entered=resolve;});
  const calls=[];
  class Transport extends EventEmitter {async start(){} dispose(){}}
  const active={key:'synthetic-session'};
  const deps={
    connections:{resolve:async()=>({provider:{authenticate:async()=>{entered();await gate;}}}),assertCurrent(){}},
    cwd:()=>null,AppServer:Transport,path:require('node:path'),resolveCli:async()=>process.execPath,
    providerClient:()=>({}),pendingLogin:{current:null,complete:()=>true},limitsEpoch:0,
    limits:{buckets:[{id:'synthetic-old'}]},broadcast(){},target:()=>active,hasChat:()=>true,
    refreshAccount:async()=>{calls.push('account');},refreshLimits:async()=>{calls.push('limits');},
    refreshCatalog:async()=>{calls.push('catalog');},loadSelected:async()=>{calls.push('load');},
    sessions:new Map(),treeEvents:{fire(){}},cliCheckRequest:true,
    ...(optIn ? {deferProviderNotifications:true,onDeferredProviderRefresh:()=>calls.push('deferred')} : {}),
  };
  const connected=connect(deps);await waiting;
  deps.server.emit('notification',{method,params:{loginId:'synthetic-login',success:true}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(deps.connectionStarting,true,'Notification arrives before provider bootstrap finishes');
  if(optIn){assert.deepEqual(calls,['deferred']);assert.equal(deps.limitsEpoch,0);}
  else{
    assert.deepEqual(calls,method==='account/login/completed'?['account','limits','catalog','load']:['account','limits','catalog']);
    assert.equal(deps.limitsEpoch,1);assert.deepEqual(deps.limits.buckets,[]);
  }
  authenticate();await connected;
}
module.exports=async()=>{
  for(const method of ['account/updated','account/login/completed']){
    await notification(method,false);await notification(method,true);
  }
};
