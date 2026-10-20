const path = require('node:path');
const {SessionStore} = require('./store.cjs');
const {McpTasks} = require('./mcp-tasks.cjs');
const {executor} = require('./mcp-executor.cjs');
const directories = require('./task-directory.cjs');
const bridgeTransport = require('./mcp-bridge.cjs');

// Owns the legacy window's MCP scheduler and bridge. UI callbacks exchange plain
// session data only; storageRoot is the existing global storage directory.
function createMcpHost({core, storageRoot, settings=()=>undefined, trusted=()=>false,
  clock={setTimeout, clearTimeout}, ui={}, version, transport=bridgeTransport,
  spaceOf=task=>task.space, taskFilter=()=>true}) {
  const {sessions, store, connections, threadReleases, turnLeases} = core;
  let tasks=null, bridge=null, lease=null, starting=null, launcher=null;
  const adapter=executor({connections,sessions,store,
    create:saved=>ui.openChat ? ui.openChat(saved) : core.createSession({key:saved.key,saved}),
    hasChat:ui.hasChat || (()=>false), closeTab:ui.closeTab, closeSavedTab:ui.closeSavedTab,
    send:(...args)=>core.send(...args), resume:(...args)=>core.resume(...args),
    handle:(s,msg)=>{
      // Match editor handle(): session actions dismiss the previous error before dispatch.
      s.error=null;
      if(msg.action==='stop')return core.stop(s);
      if(msg.action==='answer')return core.answer(s,msg);
      if(msg.action==='answerAsync')return core.answerAsync(s,msg);
      throw Error('Unsupported MCP session action.');
    },
    pending:core.pendingRequests, save:(...args)=>core.save(...args),
    alive:()=>!core.state.disposed && !!bridge,
    releases:threadReleases,
    client:()=>{
      if(!core.state.activeConnection || !core.state.server)return null;
      connections.assertCurrent(core.state.activeConnection);return core.state.server;
    },
    accessMode:()=>settings('mcpAccessMode') || 'workspace', sent:ui.sent,
    retainTurn(s,task){
      if(turnLeases.has(s.id))return;
      const unlockDirectory=directories.acquire(store,s.cwd,task.taskId);
      let unlockSession;
      try{unlockSession=store.acquire(s.id);}catch(error){unlockDirectory();throw error;}
      turnLeases.set(s.id,()=>{unlockSession();unlockDirectory();});
    },
    reloadWindow(force){
      if(typeof ui.reloadWindow!=='function')
        throw Object.assign(Error('Window reload is unsupported by this MCP host.'),{code:'unsupported'});
      if(!force && [...sessions.values()].some(s=>s.busy || s.sendingTask || s.compacting))
        throw Object.assign(Error('A Rundix chat is still working; wait for it, or pass force:true.'),{code:'task_active'});
      clock.setTimeout(()=>ui.reloadWindow(),300);
    },
    async models(){
      // Bound catalog loading by the existing bridge request budget.
      if(!core.state.catalog.length){
        let timer;
        const load=(async()=>{await core.connect();await core.refreshCatalog();})();
        try{await Promise.race([load,new Promise((_,reject)=>{timer=clock.setTimeout(()=>reject(Error('timeout')),9000);})]);}
        catch{throw Object.assign(Error('The model catalog is not available yet. Check the Codex connection in Rundix and retry.'),{code:'connection_unavailable'});}
        finally{clock.clearTimeout(timer);load.catch(()=>{});}
      }
      return core.state.catalog.map(model=>({model:model.model,displayName:model.displayName || model.model,isDefault:!!model.isDefault,
        defaultEffort:model.defaultReasoningEffort || null,efforts:(model.supportedReasoningEfforts || []).map(effort=>effort.reasoningEffort).filter(Boolean)}));
    },
  });
  function dispose(){
    tasks?.dispose();tasks=null;bridge?.dispose();bridge=null;lease?.();lease=null;
  }
  async function start(){
    if(starting)return starting;
    if(bridge)return bridge.descriptor;
    starting=(async()=>{
      if(!trusted())throw Error('Trust the VS Code workspace before starting MCP.');
      lease=store.acquire('mcp-bridge');
      try{
        const root=path.join(storageRoot,'mcp');
        transport.privateDirectory(root);
        // A locked launcher must not keep the bridge down.
        try{launcher=transport.installLauncher(root,version);}
        catch{launcher=path.join(__dirname,'mcp-server.cjs');}
        tasks=new McpTasks({store:new SessionStore(path.join(root,'tasks')),directoryStore:store,
          adapter,maxParallel:()=>settings('mcpMaxParallelTasks') ?? 3,spaceOf,taskFilter});
        bridge=await transport.serve({directory:root,call:(name,args)=>{
          if(!trusted())throw Object.assign(Error('Trust the VS Code workspace that runs the Rundix MCP bridge.'),{code:'workspace_untrusted'});
          return tasks.call(name,args);
        }});
        tasks.schedule();
        await ui.enabled?.(true);ui.changed?.();
        return bridge.descriptor;
      }catch(error){dispose();throw error;}
    })();
    try{return await starting;}finally{starting=null;}
  }
  async function stop(){
    if(starting)await starting;
    if(tasks && [...tasks.tasks.values()].some(t=>['running','waiting_approval'].includes(t.state)))
      throw Error('Cancel active MCP tasks and wait for confirmation before stopping the bridge.');
    dispose();await ui.enabled?.(false);ui.changed?.();
  }
  return {start,stop,dispose,get tasks(){return tasks;},get bridge(){return bridge;},get launcher(){return launcher;}};
}
module.exports={createMcpHost};
