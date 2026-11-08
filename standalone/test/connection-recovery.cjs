// Synthetic host lifecycle: no editor, network or real account storage.
const assert = require('node:assert/strict');
const {recoverConnection} = require('../runtime/connection-recovery.cjs');
async function main() {
  let changed=true,busy=false,active=false,stale=false,resets=0,calls=0,failReset=false;
  const provider={recoverConnection:async({assertCanChange})=>{calls++;if(changed)assertCanChange();return changed;}};
  const connection={id:'synthetic',revision:'synthetic-revision',provider};
  const deps={server:{},sessions:new Map([['synthetic',{get busy(){return busy;}}]]),
    connections:{resolve:async()=>connection,assertCurrent:()=>{if(stale)throw Error('Synthetic stale connection');}},
    store:{assertNoActiveTurns:()=>{if(active)throw Error('Synthetic active turn');}},
    resetConnection:async()=>{resets++;if(failReset)throw Error('Synthetic save failure');}};
  busy=true;await assert.rejects(recoverConnection(deps),{retryable:true});busy=false;
  active=true;await assert.rejects(recoverConnection(deps),{retryable:true});active=false;
  stale=true;await assert.rejects(recoverConnection(deps),/stale/);stale=false;
  assert.equal(resets,0);
  const before=calls;
  await assert.rejects(recoverConnection(deps,{id:'other',revision:'synthetic-revision'}),/connection changed/);
  assert.equal(calls,before,'A task cannot recover another selected connection');
  failReset=true;await assert.rejects(recoverConnection(deps),/save failure/);
  changed=false;failReset=false;await recoverConnection(deps);
  assert.equal(resets,2,'A persisted selection still needs its CLI handoff after a failed save');
  await recoverConnection(deps);assert.equal(resets,2);
  changed=true;deps.server=null;await recoverConnection(deps);assert.equal(resets,2,'Cold recovery needs no retiring CLI');
  console.log('PASS connection recovery: idle/global-turn fences, stale selection, task binding, failed handoff retry and cold startup.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
