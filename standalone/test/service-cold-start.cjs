require('./test-isolation.cjs').isolate();
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHeadlessHost}=require('../runtime/service-headless-host.cjs');
const {fixture}=require('./service-fixture.cjs');
async function scenario(parallel, transient=false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-cold-synthetic-'));
  const data=fixture(root,{cliEnv:{RUNDIX_SYNTHETIC_COLD_ACCOUNT_UPDATE:'1'}});let host;
  try {
    fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({mcpMaxParallelTasks:3}));
    host=await createHeadlessHost({root,generation:'synthetic-cold',...data.hostOptions});
    let attempts=0;
    if(transient){
      const start=host.provider.start.bind(host.provider);
      host.provider.start=async()=>{if(++attempts===1)throw Object.assign(Error('Synthetic cold bootstrap timeout'),{code:'PROVIDER_UNAVAILABLE',reason:'action_required'});return start();};
    }
    const tasks=await Promise.all(Array.from({length:parallel},async(_,i)=>{
      const project=path.join(root,'synthetic-project-'+i);fs.mkdirSync(project);
      return host.mcp.tasks.call('submit_task',{requestId:'synthetic-cold-'+i,description:'Synthetic cold task',acceptanceCriteria:'Synthetic success',projectDirectory:project});
    }));
    if(transient){
      await host.mcp.tasks.tick();await host.mcp.tasks.idle();
      assert.equal(host.mcp.tasks.get(tasks[0].taskId).state,'queued','Definite cold bootstrap timeout stays queued');
    }
    for(const task of tasks){
      const done=await host.mcp.tasks.call('wait_task',{taskId:task.taskId,waitSeconds:10});
      assert.equal(done.state,'completed','Login notification must not poison the initial catalog read');
      assert.equal(done.report.result,'Synthetic success');
    }
    assert.equal(data.children.length,2,'Racing tasks share one provider and one ephemeral CLI');
    if(transient)assert.equal(attempts,2,'Only a definite pre-dispatch bootstrap is retried');
  }finally{await host?.dispose({force:true});await data.close();fs.rmSync(root,{recursive:true,force:true});}
}
(async()=>{
  const {startupFailure}=require('../runtime/service-readiness.cjs');
  for(const code of ['AUTH_REQUIRED','AUTH_REVOKED','PROVIDER_CONFIG_INVALID','STORE_UNAVAILABLE'])
    assert(!startupFailure(Object.assign(Error('Synthetic access refusal'),{code}),'authentication').retryable);
  await scenario(1);await scenario(2);await scenario(1,true);
  console.log('PASS cold provider login: fenced account notification, single/racing submissions, bounded bootstrap queue and genuine access refusals.');
})()
  .catch(error=>{console.error(error);process.exitCode=1;});
