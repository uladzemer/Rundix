// Explicitly synthetic identities, models, paths and message data.
const assert=require('node:assert/strict');
const {createTurnDiagnostics,errorCategory,safeOutcome}=require('../runtime/turn-diagnostics.cjs');
function fixture(write){
  const lines=[];let time=1000;
  const tracker=createTurnDiagnostics({now:()=>time,write:write || (value=>lines.push(value))});
  const s={id:'synthetic-thread',lastStartedTurnId:'synthetic-previous'},client={},connection={};
  const options={client,connection,accountKey:'chatgpt:synthetic@example.test',modelKey:'synthetic-private-model',fast:false};
  const event=(method,id,status='completed',error)=>({method,params:{threadId:s.id,turn:{id,status,error}}});
  return {tracker,lines,s,client,connection,options,event,advance:value=>{time+=value;}};
}
{
  const f=fixture();
  const run=(id,change={},status='completed',error)=>{
    const options={...f.options,...change};const ticket=f.tracker.begin(f.s,options);
    f.tracker.observe(f.s,f.event('turn/started',id),options.client);
    f.advance(2000);f.tracker.accepted(ticket,id);
    f.tracker.observe(f.s,f.event('turn/completed',id,status,error),options.client);
    f.s.lastStartedTurnId=id;
  };
  run('synthetic-1');run('synthetic-2',{},'failed',{codexErrorInfo:'serverOverloaded',message:'SYNTHETIC_SECRET'});
  run('synthetic-3',{client:{}},'failed',{codexErrorInfo:'unauthorized',message:'SYNTHETIC_SECRET'});
  run('synthetic-4',{accountKey:'synthetic-second',fast:true},'failed',{codexErrorInfo:'serverOverloaded'});
  assert.deepEqual(f.lines.map(row=>row.transition),['first','same_client','client_changed','account_changed']);
  assert.deepEqual(f.lines.map(row=>row.category),['none','serverOverloaded','unauthorized','serverOverloaded']);
  assert.deepEqual(f.lines.map(row=>row.account),[1,1,1,2]);assert.equal(f.lines[3].fast,true);
  assert.equal(f.lines[0].elapsedSeconds,2);assert.equal(f.lines[0].model,1);
  const text=JSON.stringify(f.lines);for(const secret of ['SYNTHETIC_SECRET','@example.test','synthetic-private-model','synthetic-thread'])assert.equal(text.includes(secret),false);
}
{
  const f=fixture(),ticket=f.tracker.begin(f.s,f.options);
  f.tracker.observe(f.s,f.event('turn/completed','synthetic-old'),f.client);
  assert.equal(f.lines.length,0);
  f.tracker.accepted(ticket,'synthetic-new');
  f.tracker.observe(f.s,f.event('turn/completed','synthetic-new'),{});assert.equal(f.lines.length,0);
  f.tracker.observe(f.s,f.event('turn/completed','synthetic-old'),f.client);assert.equal(f.lines.length,0);
  f.tracker.observe(f.s,f.event('turn/completed','synthetic-new'),f.client);
  f.tracker.observe(f.s,f.event('turn/completed','synthetic-new'),f.client);assert.equal(f.lines.length,1);
}
{
  const f=fixture(),ticket=f.tracker.begin(f.s,f.options);
  f.tracker.observe(f.s,f.event('turn/completed','synthetic-before-reply','failed',{codexErrorInfo:'serverOverloaded'}),f.client);
  f.tracker.accepted(ticket,'synthetic-before-reply');assert.equal(f.lines.length,1);
  f.tracker.accepted(ticket,'synthetic-before-reply');assert.equal(f.lines.length,1);
}
for(const invalidate of ['disconnect','clear','replace']){
  const f=fixture(),ticket=f.tracker.begin(f.s,f.options);
  f.tracker.observe(f.s,f.event('turn/completed','synthetic-late'),f.client);
  if(invalidate==='disconnect')f.tracker.disconnect(f.client);
  if(invalidate==='clear')f.tracker.clear();
  if(invalidate==='replace')f.tracker.begin(f.s,f.options);
  f.tracker.accepted(ticket,'synthetic-late');assert.equal(f.lines.length,0,invalidate);
}
{
  const f=fixture(),ticket=f.tracker.begin(f.s,f.options);
  f.tracker.observe(f.s,f.event('turn/started','synthetic-older'),f.client);
  f.tracker.observe(f.s,f.event('turn/completed','synthetic-older','failed',{codexErrorInfo:'serverOverloaded'}),f.client);
  assert.equal(f.lines.length,0,'A late start notification cannot bind the new dispatch');
  f.tracker.accepted(ticket,'synthetic-current');
  f.tracker.observe(f.s,f.event('turn/completed','synthetic-current'),f.client);
  assert.equal(f.lines.length,1);assert.equal(f.lines[0].status,'completed');
}
{
  const f=fixture();for(let i=0;i<35;i++){
    const ticket=f.tracker.begin(f.s,{...f.options,accountKey:'synthetic-'+i,modelKey:'synthetic-model-'+i});
    f.tracker.accepted(ticket,'synthetic-'+i);
    f.tracker.observe(f.s,f.event('turn/completed','synthetic-'+i),f.client);
  }
  assert.equal(f.lines[32].account,0);assert.equal(f.lines[32].model,0);assert.equal(f.lines[33].transition,'unknown_account');
}
{
  const f=fixture(()=>{throw Error('Synthetic logging failure');});
  const ticket=f.tracker.begin(f.s,f.options);f.tracker.accepted(ticket,'synthetic-1');
  assert.doesNotThrow(()=>f.tracker.observe(f.s,f.event('turn/completed','synthetic-1'),f.client));
  assert.equal(errorCategory({codexErrorInfo:'usageLimitExceeded',message:'Selected model is at capacity'}),'usageLimitExceeded');
  assert.equal(errorCategory({codexErrorInfo:{httpConnectionFailed:{httpStatusCode:503,secret:'SYNTHETIC_SECRET'}}}),'httpConnectionFailed');
  const value=safeOutcome({attempt:Infinity,account:-1,model:99,transition:'SYNTHETIC_SECRET',category:'SYNTHETIC_SECRET',message:'SYNTHETIC_SECRET'});
  assert.equal(JSON.stringify(value).includes('SYNTHETIC_SECRET'),false);
}
console.log('Turn diagnostics: fixed privacy projection, account/client comparisons, stale/duplicate results and bounded aliases passed.');
