require('./test-isolation.cjs').isolate();
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {runService} = require('../runtime/service-main.cjs');
const {connectService} = require('../runtime/service-endpoint.cjs');
const {fixture} = require('./service-fixture.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-refresh-synthetic-'));
  const data = fixture(root, {cliEnv:{RUNDIX_SYNTHETIC_REFRESH:'1'}});let service, peer;
  try {
    service = await runService({root, hostOptions:data.hostOptions});await service.host.core.connect();
    await service.host.provider.configureByClient({clientId:'synthetic',operationId:'synthetic-refuse',expectedSelectionRevision:1,action:'synthetic',payload:{scenario:'refresh-refuse-AUTH_REVOKED'}});
    peer = await connectService({root,hello:{clientKind:'adapter',binding:{source:'cwd',launchDirectory:root}}});
    const call = async (name, args) => {const value = await peer.call('task.call',{bindingId:peer.binding.bindingId,spaceId:peer.binding.spaceId,name,arguments:args});assert(!value.error);return value.result;};
    const task = await call('submit_task',{requestId:'synthetic-submit',description:'Synthetic refresh task',acceptanceCriteria:'Synthetic checks',projectDirectory:root});
    const failed = await call('wait_task',{taskId:task.taskId,waitSeconds:2});
    assert.equal(failed.state,'error');assert.match(failed.error,/action_required/);assert(!failed.timedOut);
    assert.equal(service.host.provider.activeTurns,1,'Refusal is not terminal proof');assert(failed.recoveryRequired);
    assert(!service.host.provider.cli.authenticated);assert.equal(service.host.provider.accountGrant,null);
    for (let tries = 0; tries < 100 && service.host.provider.activeTurns; tries++) await pause(20);
    assert.equal(service.host.provider.activeTurns,0);
    for (let tries = 0; tries < 100; tries++) {await service.host.mcp.tasks.tick();if (!(await call('get_task',{taskId:task.taskId})).recoveryRequired) break;await pause(20);}
    const settled = await call('get_task',{taskId:task.taskId});assert.equal(settled.state,'error');assert.match(settled.error,/action_required/);assert.equal(settled.recoveryRequired,false);
    assert.equal((await service.host.provider.status()).counts.handleRequest,1);
    const records = [...service.host.mcp.tasks.tasks.values()];assert.equal(records.length,1);assert(!records[0].nextInput);
    peer.close();peer = null;await pause(20);assert((await service.dispose()).exiting);service = null;
    console.log('PASS refresh refusal: real IPC action_required, closed gate, retained live grant, terminal reconciliation and no replay.');
  } finally {
    peer?.close();try {await service?.dispose();} catch {}await service?.endpoint.dispose();await data.close();
    assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-refresh-synthetic-'));fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
