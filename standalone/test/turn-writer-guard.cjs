const assert=require('node:assert/strict');
const {assertNoActiveWriter}=require('../runtime/turn-writer-guard.cjs');
const locale={t:text=>text};
(async()=>{
  const s={id:'synthetic-thread',busy:false,turnId:null};
  const deps={locale,server:{request:async()=>({data:[{id:'synthetic-active-turn',status:'inProgress'}]})}};
  await assert.rejects(assertNoActiveWriter(deps,s),error=>error.retryable&&error.notSent);
  assert.equal(s.busy,true);assert.equal(s.turnId,'synthetic-active-turn');
  deps.server.request=async()=>({data:[{id:'synthetic-complete-turn',status:'completed'}]});
  await assertNoActiveWriter(deps,s);
  console.log('turn-writer-guard: synthetic active-writer handoff checks passed');
})().catch(error=>{console.error(error);process.exitCode=1});
