const assert=require('node:assert/strict');const {startLogin,identity}=require('../runtime/account.cjs');
require('./turn-diagnostics.cjs');
(async()=>{const calls=[],opened=[],server={request:async(method,params)=>{calls.push({method,params});return method==='account/login/start'?{loginId:'fixture-login',authUrl:'https://auth.openai.com/fixture'}:{};}};
 assert.equal(await startLogin(server,{openExternal:async url=>{opened.push(url);return true;}}),'fixture-login');assert.deepEqual(calls.map(call=>call.method),['account/login/start']);assert.deepEqual(calls[0].params,{type:'chatgpt'});assert.equal(opened.length,1);
 calls.length=0;await startLogin(server,{openExternal:async()=>true});assert.equal(calls.length,1);assert.equal(calls[0].method,'account/login/start');assert.notEqual(identity({type:'chatgpt',email:'first@example.test'}),identity({type:'chatgpt',email:'second@example.test'}));
 await assert.rejects(startLogin({request:async()=>({authUrl:'file:///fixture'})},{openExternal:async()=>{throw Error('Must not open');}}),/адрес/);
 const {PendingLogin} = require('../runtime/pending-login.cjs');
 const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
 // Run the real host pending-login callback and external-history disposal path.
 const synthetic={key:'synthetic-session',id:'synthetic-thread',loaded:true,lastStartedTurnId:'synthetic-stale-turn',items:[],persistedRecord:{revision:1,items:[]}};
 const context=({PendingLogin,authBusy:true,authOwner:null,loginId:'synthetic-login',
  server:{dispose(){this.disposed=true;}},connecting:{},activeConnection:{},account:{},catalog:[],catalogUpdatedAt:0,
  target:()=>synthetic,broadcast(){},sessions:new Map([[synthetic.key,synthetic]]),
  store:{session:()=>({revision:2,items:[{id:'synthetic-item'}]})},locale:{t:text=>text}});
 context.pending=context.pendingLogin=require('../runtime/account-lifecycle.cjs').createPendingLogin(context);
 assert.equal(context.pending.timeout,5*60*1000,'Host limits pending browser sign-in to five minutes');
 let releases=0;context.release=()=>releases++;
 context.authOwner=context.release;context.pending.begin(context.server,context.release).id="synthetic-login";
 const sync=s=>require('../runtime/session-persistence.cjs').syncExternal(context,s);
 await sync(synthetic);
 assert.equal(context.pending.current,null);assert.equal(context.authBusy,false);assert.equal(context.authOwner,null);
 assert.equal(context.loginId,null);assert.equal(releases,1);assert.equal(context.server.disposed,true);
 assert.equal(synthetic.loaded,false);assert.equal(synthetic.lastStartedTurnId,null,'External history invalidates the locally remembered turn');
 const message=(...args)=>require('../runtime/account-lifecycle.cjs').browserSignInMessage(context,...args);
 for(const language of ['ru','en']){
  context.locale.language=language;
  assert.match(message(),language==='en'?/account menu/:/меню аккаунта/);
  assert.match(message(true),language==='en'?/another window.*account menu/:/другом окне.*меню аккаунта/);
 }
 const {SessionStore}=require('../runtime/store.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-synthetic-login-'));
 try {
  const store=new SessionStore(root), other=new SessionStore(root), notices=[];
  const pending=new PendingLogin({onFinish:error=>notices.push(error),timeout:20});
  let cancelled=0, disposed=0;
  const client={request:async(method,params)=>{assert.equal(method,'account/login/cancel');assert.equal(params.loginId,'fixture');cancelled++;},dispose:()=>disposed++};
  const record=pending.begin(client,store.acquire('account-credentials'));record.id='fixture';
  assert.throws(()=>other.acquire('account-credentials'));
  assert.equal(pending.complete({},'fixture'),false);
  assert.equal(pending.complete(client,'stale'),false);
  assert.equal(pending.complete(client,'fixture'),true);
  other.acquire('account-credentials')();
  assert.equal(pending.finish(record),false);
  const cancelledRecord=pending.begin(client,store.acquire('account-credentials'));cancelledRecord.id='fixture';
  await pending.cancel();assert.equal(cancelled,1);other.acquire('account-credentials')();
  const failed=pending.begin({...client,request:async()=>{throw Error('synthetic cancel failure');}},store.acquire('account-credentials'));failed.id='fixture';
  await assert.rejects(pending.cancel(),/synthetic/);assert.equal(disposed,1);other.acquire('account-credentials')();
  pending.begin(client,store.acquire('account-credentials')).id='fixture';
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(pending.current,null);assert.equal(cancelled,2);assert.match(notices.at(-1),/timed out/);other.acquire('account-credentials')();
 } finally {fs.rmSync(root,{recursive:true,force:true});}
 console.log('PASS: local browser sign-in uses only the official login RPC; URLs validated and account identities isolated.');
})().catch(error=>{console.error(error);process.exitCode=1});
