// Synthetic regression cases: transport boundaries, recovery capacity and provider availability.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {PassThrough}=require('node:stream');
const {SessionStore}=require('../runtime/store.cjs');
const {McpTasks}=require('../runtime/mcp-tasks.cjs');
const {executor}=require('../runtime/mcp-executor.cjs');
const {serve,request}=require('../runtime/mcp-bridge.cjs');
const {run,wait}=require('../runtime/mcp-server.cjs');
const directories=require('../runtime/task-directory.cjs');
const next=()=>new Promise(resolve=>setImmediate(resolve));
module.exports=async function checks(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-mcp-defects-synthetic-')),open=[];
  try{
    const project=name=>{const dir=path.join(root,'synthetic-'+name);fs.mkdirSync(dir);return dir;};
    const a=project('a'),b=project('b');
    const connection={id:'synthetic-pool',owner:'synthetic.companion',revision:'synthetic-revision'};
    let unavailable=true,resolveGate=null;
    const connections={selection:()=>connection,resolve:async()=>{if(resolveGate)await resolveGate;if(unavailable)throw Error('Synthetic unavailable companion');return {...connection,provider:{}};}};
    const adapter=executor({connections,sessions:new Map(),store:{session:()=>null},create:()=>{throw Error('Unexpected synthetic create');},pending:new Map()});
    const tasks=new McpTasks({store:new SessionStore(path.join(root,'tasks-connection')),adapter});tasks.schedule=()=>{};open.push(tasks);
    const submit={requestId:'synthetic-unavailable',description:'Synthetic task',acceptanceCriteria:'Synthetic checks',projectDirectory:a};
    await assert.rejects(tasks.call('submit_task',submit),error=>error.code==='connection_unavailable');
    assert.equal(tasks.tasks.size,0);assert.equal(fs.readdirSync(tasks.store.directory).filter(n=>n.startsWith('mcp-task-')).length,0);
    unavailable=false;let releaseResolve;resolveGate=new Promise(resolve=>{releaseResolve=resolve;});
    const first=tasks.call('submit_task',submit),replay=tasks.call('submit_task',submit);
    assert.throws(()=>tasks.call('submit_task',{...submit,description:'Synthetic different'}),error=>error.code==='request_conflict');
    releaseResolve();const accepted=await first;assert.equal((await replay).taskId,accepted.taskId);assert.equal(tasks.tasks.size,1);resolveGate=null;
    unavailable=true;await tasks.tick();await tasks.idle();
    const refused=tasks.get(accepted.taskId);assert.equal(refused.state,'error');assert.equal(refused.recoveryRequired,false);
    assert.doesNotThrow(()=>directories.acquire(tasks.directoryStore,a,'synthetic-probe')());

    // A lost start/checkpoint or failed status read must keep the sole parallel slot reserved.
    for(const failure of ['start','checkpoint','status']){
      let started=0,live=true,readFails=true,probes=0;
      const stub={connection:()=>connection,assertConnection(){},pending:()=>[],chatId:()=> 'synthetic-chat',
        async start(task,_input,checkpoint){started++;if(started===1 && failure!=='status'){
          if(failure==='checkpoint'){task.turnId='synthetic-accepted-turn';checkpoint();}
          throw Error('Synthetic lost start response or checkpoint');
        }},
        async status(){probes++;if(readFails)throw Error('Synthetic unavailable status');return {done:!live,report:{result:'Synthetic result',changedFiles:[],checks:[],remainingIssues:[]}};}};
      const scheduler=new McpTasks({store:new SessionStore(path.join(root,'tasks-'+failure)),adapter:stub,maxParallel:()=>1});scheduler.schedule=()=>{};open.push(scheduler);
      const one=scheduler.call('submit_task',{...submit,requestId:'synthetic-first-'+failure});
      const two=scheduler.call('submit_task',{...submit,requestId:'synthetic-second-'+failure,projectDirectory:b});
      if(failure==='checkpoint'){
        const write=scheduler.store.write.bind(scheduler.store);let failOnce=true;
        scheduler.store.write=(type,id,value)=>{if(type==='mcp-task' && value.turnId && failOnce){failOnce=false;throw Error('Synthetic checkpoint write failure');}return write(type,id,value);};
      }
      await scheduler.tick();await scheduler.idle();await scheduler.tick();await scheduler.idle();
      assert.equal(scheduler.get(one.taskId).state,'error');assert.equal(scheduler.get(one.taskId).recoveryRequired,true);
      assert.equal(scheduler.get(two.taskId).state,'queued');assert.equal(started,1);
      assert(probes>0,'Recovery probes run even with zero free capacity');
      readFails=false;await scheduler.tick();assert.equal(started,1);assert.equal(scheduler.get(one.taskId).state,'running');
      live=false;await scheduler.tick();await scheduler.idle();assert.equal(started,2,'Confirmed inactive turn releases its parallel slot');
      scheduler.dispose();
    }

    const reports=new McpTasks({store:new SessionStore(path.join(root,'tasks-reports')),adapter:{pending:()=>[]}});reports.schedule=()=>{};open.push(reports);
    for(let i=0;i<20;i++)reports.tasks.set('synthetic-report-'+i,{taskId:'synthetic-report-'+i,state:'completed',operations:[],projectDirectory:a,
      report:{result:'Ж'.repeat(30000),changedFiles:[],checks:[],remainingIssues:[]}});
    const ids=[...reports.tasks.keys()];
    assert.throws(()=>reports.call('wait_tasks',{taskIds:ids}),error=>error.code==='response_too_large' && /brief:true/.test(error.message));
    assert.equal(reports.call('wait_tasks',{taskIds:ids,brief:true}).settled.length,20);
    const bridge=await serve({directory:path.join(root,'bridge'),call:(name,args)=>name==='echo'?args:name==='oversized'?'x'.repeat(1024*1024):reports.call(name,args)});open.push(bridge);
    await assert.rejects(request(bridge.descriptor,'oversized',{}),error=>error.code==='response_too_large');
    let output='';assert.equal(await wait(bridge.descriptor,ids.join(','),10,{output:{write:text=>{output+=text;}}}),0);
    assert.equal(JSON.parse(output).settled.length,20);assert(Object.hasOwn(JSON.parse(output).settled[0],'reportSummary'));
    // Deferred oversized results reject the waiter without throwing into save()/task state transitions.
    for(const task of reports.tasks.values())task.state='running';
    const deferred=reports.call('wait_tasks',{taskIds:ids,waitSeconds:5});
    const deferredCheck=assert.rejects(deferred,error=>error.code==='response_too_large');
    for(const task of reports.tasks.values())task.state='completed';
    assert.doesNotThrow(()=>reports.save(reports.get(ids[0])));await deferredCheck;assert.equal(reports.waiters.size,0);

    // Force a multibyte code point to straddle HTTP chunks in both directions.
    const config=JSON.parse(fs.readFileSync(bridge.descriptor,'utf8')),unicode='Synthetic Ж😀';
    const body=Buffer.from(JSON.stringify({name:'echo',arguments:{text:unicode}}));
    const cut=body.indexOf(Buffer.from('Ж'))+1;
    const echoed=await new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:config.port,path:'/call',method:'POST',headers:{Authorization:'Bearer '+config.secret}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks))));res.on('error',reject);
      });req.on('error',reject);req.write(body.subarray(0,cut));setTimeout(()=>req.end(body.subarray(cut)),20);
    });assert.equal(echoed.result.text,unicode);
    const remote=http.createServer(async(_req,res)=>{const bytes=Buffer.from(JSON.stringify({result:{text:unicode}})),split=bytes.indexOf(Buffer.from('😀'))+2;res.write(bytes.subarray(0,split));await new Promise(r=>setTimeout(r,20));res.end(bytes.subarray(split));});
    await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));open.push({dispose(){remote.closeAllConnections();remote.close();}});
    const descriptor=path.join(root,'synthetic-response-bridge.json');fs.writeFileSync(descriptor,JSON.stringify({version:1,port:remote.address().port,secret:'a'.repeat(64)}));
    assert.equal((await request(descriptor,'echo',{})).text,unicode);

    // Local validation and unexpected failures always carry a safe error code.
    const input=new PassThrough(),lines=[],sink={write:text=>lines.push(JSON.parse(text))};run(bridge.descriptor,input,sink);
    input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n');
    for(const [id,params] of [[2,{name:'submit_task',arguments:{}}],[3,{name:'list_models',arguments:{unknown:true}}]])input.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params})+'\n');
    await next();for(const id of [2,3])assert.match(lines.find(line=>line.id===id).result.content[0].text,/^invalid_argument: /);
    // An uncoded bridge failure must never expose its diagnostic.
    const unsafe=await serve({directory:path.join(root,'bridge-unsafe'),call:()=>{throw Error('Synthetic private diagnostic must stay hidden');}});open.push(unsafe);
    const input2=new PassThrough(),output2=[];run(unsafe.descriptor,input2,{write:text=>output2.push(JSON.parse(text))});
    input2.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n');input2.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_models',arguments:{}}})+'\n');
    for(let i=0;i<100 && output2.length<2;i++)await new Promise(r=>setTimeout(r,5));
    assert.match(output2[1].result.content[0].text,/^rejected: /);assert(!JSON.stringify(output2).includes('private diagnostic'));
    // Exercise the stdio adapter's own uncoded-error fallback, independently of HTTP sanitization.
    const syntheticModule={exports:{}};
    require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname,'../runtime/mcp-server.cjs'),'utf8'),{
      module:syntheticModule,require:id=>id==='./mcp-bridge.cjs'?{request:async()=>{throw Error('Synthetic private local diagnostic');}}:require(id),process,Buffer,setTimeout,clearTimeout,
    });
    const input3=new PassThrough(),output3=[];syntheticModule.exports.run('synthetic-descriptor',input3,{write:text=>output3.push(JSON.parse(text))});
    input3.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n');input3.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_models',arguments:{}}})+'\n');
    await next();assert.match(output3[1].result.content[0].text,/^rejected: /);assert(!JSON.stringify(output3).includes('private local diagnostic'));
    console.log('MCP defects: provider fail-closed/replay, pre-send cleanup, uncertain slot capacity, response limits/brief fallback, split UTF-8 and safe coded errors passed.');
  }finally{for(const item of open)item.dispose();fs.rmSync(root,{recursive:true,force:true});}
};
