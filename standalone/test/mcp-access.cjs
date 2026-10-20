const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {executor,taskTitle}=require('../runtime/mcp-executor.cjs');
const {canonical}=require('../runtime/task-directory.cjs');
function hostDepsChecks(){
  // Static wiring contract only: never extract or execute extension function source.
  const host=fs.readFileSync(path.join(__dirname,'../extension.cjs'),'utf8');
  const block=host.match(/^  const hostDeps = \{([\s\S]*?)^  \};/m);
  assert.ok(block,'Host dependency object is declared');
  const getters=new Set([...block[1].matchAll(/\bget\s+(\w+)\s*\(/g)].map(match=>match[1]));
  const setters=new Set([...block[1].matchAll(/\bset\s+(\w+)\s*\(/g)].map(match=>match[1]));
  const optional=new Set(['Date','setTimeout','clearTimeout']);
  for(const name of ['account-lifecycle','mcp-access','question-answer','question-policy','send-queue','server-connection','session-persistence','session-resume']){
    const source=fs.readFileSync(path.join(__dirname,'../runtime/'+name+'.cjs'),'utf8');
    for(const match of source.matchAll(/\bdeps\.([\w$]+)/g)){
      const key=match[1];if(optional.has(key))continue;
      assert.ok(getters.has(key),name+': missing hostDeps getter '+key);
      const after=source.substring(match.index+match[0].length);
      const before=source.substring(0,match.index);
      if(/^\s*(?:\+\+|--|(?:\*\*|>>>|>>|<<|&&|\|\||\?\?|[+\-*/%&|^])?=(?!=|>))/.test(after) || /(?:\+\+|--)\s*$/.test(before))
        assert.ok(setters.has(key),name+': missing hostDeps setter '+key);
    }
  }
  console.log('Host deps: getters and assignment setters cover all eight runtime modules.');
}
async function main(){
  hostDepsChecks();
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
    assert.deepEqual(created[0].prefs,{mode:'full',access:'full',ide:false,plan:false,focus:true},'MCP chats open in focus mode');
    assert.equal(full.accessMode,'full');
    assert.equal(created[0].name,'MCP · Synthetic refactor of the greeting module Second line is ignored');assert.equal(created[0].customName,true);
    assert.equal(created[0].mcpTask,true,'MCP chats are marked for per-thread config');

    // Per-thread Codex config applies only to MCP chats and only from user settings.
    {
      let inspected={globalValue:{mcp_servers:{synthetic:{enabled:false}}},workspaceValue:{features:{synthetic:true}}};
      const fn=s=>require('../runtime/mcp-access.cjs').mcpThreadConfig({vscode:{workspace:{getConfiguration:()=>({inspect:()=>inspected})}}},s);
      assert.deepEqual(fn({mcpTask:true}),{mcp_servers:{synthetic:{enabled:false}}});
      assert.equal(fn({mcpTask:false}),null,'Ordinary chats get no override');
      inspected={workspaceValue:{features:{synthetic:true}}};assert.equal(fn({mcpTask:true}),null,'Workspace settings are ignored');
      inspected={globalValue:{}};assert.equal(fn({mcpTask:true}),null);
      const source=fs.readFileSync(path.join(__dirname,'../runtime/send-queue.cjs'),'utf8')+fs.readFileSync(path.join(__dirname,'../runtime/session-resume.cjs'),'utf8');
      assert.equal((source.match(/deps\.mcpThreadConfig\(s\)\?\{config:deps\.mcpThreadConfig\(s\)\}/g) || []).length,2,'Used for thread/start and thread/resume');
      assert.match(fs.readFileSync(path.join(__dirname,'../runtime/session-persistence.cjs'),'utf8'),/mcpTask:!!s\.mcpTask/,'The marker is persisted for resumes after reload');
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
    assert.equal(taskTitle('x'.repeat(200)).length,'MCP · '.length+160);assert.match(taskTitle('x'.repeat(200)),/…$/);

    const manifest=require('../package.json').contributes.configuration.properties['rundix.mcpAccessMode'];
    assert.equal(manifest.scope,'application');assert.equal(manifest.default,'workspace');
    const source=fs.readFileSync(path.join(__dirname,'../extension.cjs'),'utf8');
    assert.match(source,/inspect\('mcpAccessMode'\)\?\.globalValue/,'Workspace settings must not grant MCP access');
    for(const file of ['../package.nls.json','../package.nls.ru.json'])for(const key of ['description','workspace','manual','auto','full'])assert.ok(require(file)['configuration.mcpAccessMode.'+key]);
    console.log('MCP access: configured mode on new task chats, safe fallback, user-scope only, existing chats untouched and task titles passed.');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error('MCP access synthetic checks failed:',error.message);process.exitCode=1;});
