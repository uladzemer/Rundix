const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {executor,taskTitle}=require('../runtime/mcp-executor.cjs');
const {canonical}=require('../runtime/task-directory.cjs');
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-mcp-access-synthetic-'));
  try{
    const project=canonical(root);
    const created=[];let mode='full';let saved=null;
    const adapter=executor({connections:{selection:()=>({id:'synthetic-pool',owner:'synthetic',revision:1})},sessions:new Map(),
      store:{session:()=>saved},create:record=>{created.push(record);return {...record,id:null,items:[],cwd:project};},
      send:async()=>{},resume:async()=>{},handle:async()=>{},pending:new Map(),save:async()=>{},alive:()=>true,accessMode:()=>mode});
    const task=(description)=>({taskId:'synthetic-task',sessionKey:'synthetic-session-'+created.length,projectDirectory:project,description,
      connection:{id:'synthetic-pool',owner:'synthetic',revision:1}});

    const full=task('Synthetic refactor of the greeting module\nSecond line is ignored');
    await adapter.status(full);
    assert.deepEqual(created[0].prefs,{mode:'full',access:'full',ide:false,plan:false});
    assert.equal(full.accessMode,'full');
    assert.equal(created[0].name,'MCP · Synthetic refactor of the greeting module');assert.equal(created[0].customName,true);
    assert.equal(created[0].mcpTask,true,'MCP chats are marked for per-thread config');

    // Per-thread Codex config applies only to MCP chats and only from user settings.
    {
      const source=fs.readFileSync(path.join(__dirname,'../extension.cjs'),'utf8');
      const start=source.indexOf('  function mcpThreadConfig(s) {'),end=source.indexOf('  async function resume(',start);
      assert.ok(start>=0 && end>start);
      let inspected={globalValue:{mcp_servers:{synthetic:{enabled:false}}},workspaceValue:{features:{synthetic:true}}};
      const fn=require('node:vm').runInNewContext('('+source.slice(start,end).replace(/^\s*\/\/.*\n/m,'').trim()+')',{vscode:{workspace:{getConfiguration:()=>({inspect:()=>inspected})}}});
      assert.deepEqual(fn({mcpTask:true}),{mcp_servers:{synthetic:{enabled:false}}});
      assert.equal(fn({mcpTask:false}),null,'Ordinary chats get no override');
      inspected={workspaceValue:{features:{synthetic:true}}};assert.equal(fn({mcpTask:true}),null,'Workspace settings are ignored');
      inspected={globalValue:{}};assert.equal(fn({mcpTask:true}),null);
      assert.equal((source.match(/mcpThreadConfig\(s\)\?\{config:mcpThreadConfig\(s\)\}/g) || []).length,2,'Used for thread/start and thread/resume');
      assert.match(source,/mcpTask:!!s\.mcpTask/,'The marker is persisted for resumes after reload');
      const setting=require('../package.json').contributes.configuration.properties['rundix.mcpThreadConfig'];
      assert.equal(setting.scope,'application');assert.deepEqual(setting.default,{});
    }

    mode='plan';await adapter.status(task('Synthetic plan request'));
    assert.equal(created[1].prefs.mode,'workspace','Plan or unknown modes fall back to the default');
    mode='manual';await adapter.status(task('Synthetic review'));
    assert.deepEqual([created[2].prefs.mode,created[2].prefs.access],['manual','read']);

    saved={key:'synthetic-saved',cwd:project,prefs:{mode:'workspace',access:'workspace'},name:'Renamed by user'};mode='full';
    await adapter.status(task('Synthetic continuation'));
    assert.equal(created[3],saved,'An existing chat keeps its own mode and name');

    assert.equal(taskTitle('  \n  '),'MCP task');
    assert.equal(taskTitle('x'.repeat(80)).length,'MCP · '.length+60);assert.match(taskTitle('x'.repeat(80)),/…$/);

    const manifest=require('../package.json').contributes.configuration.properties['rundix.mcpAccessMode'];
    assert.equal(manifest.scope,'application');assert.equal(manifest.default,'workspace');
    const source=fs.readFileSync(path.join(__dirname,'../extension.cjs'),'utf8');
    assert.match(source,/inspect\('mcpAccessMode'\)\?\.globalValue/,'Workspace settings must not grant MCP access');
    for(const file of ['../package.nls.json','../package.nls.ru.json'])for(const key of ['description','workspace','manual','auto','full'])assert.ok(require(file)['configuration.mcpAccessMode.'+key]);
    console.log('MCP access: configured mode on new task chats, safe fallback, user-scope only, existing chats untouched and task titles passed.');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error('MCP access synthetic checks failed:',error.message);process.exitCode=1;});
