// Synthetic admission failure before and after provider reservation; no real CLI.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHeadlessHost}=require('../runtime/service-headless-host.cjs');
const pause=()=>new Promise(resolve=>setTimeout(resolve,20));
async function until(check){const deadline=Date.now()+8000;while(!check()){assert(Date.now()<deadline,'Synthetic admission deadline');await pause();}}
(async()=>{
  for(const failAt of [1,2]){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-admission-synthetic-')),project=path.join(root,'synthetic-project');fs.mkdirSync(project);
    const fixture=require('./service-fixture.cjs').fixture(root);let host,calls=0,blocked=true;
    try{
      host=await createHeadlessHost({...fixture.hostOptions,root,generation:'synthetic-admission',taskOptions:{scope:()=> 'synthetic-space'},beforeAdmission:async()=>{
        if(blocked && ++calls===failAt)throw Object.assign(Error('Synthetic legacy owner busy'),{code:'legacy_owner_active'});
      }});
      const view=await host.mcp.tasks.call('submit_task',{requestId:'synthetic-admission-'+failAt,description:'Synthetic admission task',acceptanceCriteria:'Synthetic report',projectDirectory:project});
      const task=host.mcp.tasks.tasks.get(view.taskId);
      await until(()=>task.state==='queued' && task.blockedReason==='legacy_owner_active');
      assert(task.blockedUntil>Date.now());assert.equal(task.recoveryRequired,false);assert.equal(task.needsReconcile,false);
      assert.equal(host.mcp.tasks.summary(task).blockedReason,'legacy_owner_active');assert.equal(host.mcp.tasks.view(task).error,'legacy_owner_active');assert(task.nextInput.includes('Synthetic admission task'));
      assert.equal(host.core.sessions.get(task.sessionKey).items.filter(item=>item.type==='agentMessage').length,0,'No turn dispatched through a blocked gate');
      blocked=false;task.blockedUntil=0;host.mcp.tasks.schedule();await until(()=>task.state==='completed');
      assert.equal(task.blockedReason,undefined);assert.equal(task.error,null);
    }finally{await host?.dispose({force:true});await fixture.close();assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-admission-synthetic-'));fs.rmSync(root,{recursive:true,force:true});}
  }
  console.log('PASS admission gates: both refusals keep queued input/code/deadline, release reservations and recover without a duplicate turn.');
})().catch(error=>{console.error(error);process.exitCode=1;});
