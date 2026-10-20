const fs=require('node:fs');
const path=require('node:path');
const {recoveryRequired}=require('./mcp-tasks.cjs');
function readRecords(directory) {
  if(!fs.existsSync(directory))return [];
  return fs.readdirSync(directory).filter(name=>/^mcp-task-[\w-]+\.json$/.test(name)).map(name=>{
    const record=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
    if(record.taskId!==name.slice(9,-5) || !record.sessionKey)throw Error('MCP task metadata is unavailable.');
    return record;
  });
}
function snapshot({records,language,connection,connected,bridgeRunning,pending}) {
  const tasks=records.slice().sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,100).map(task=>({
    taskId:task.taskId,title:(task.description || task.taskId).slice(0,160),state:task.state,
    chatId:task.chatId || null,projectDirectory:task.projectDirectory,progress:task.progress,
    report:task.report || null,error:task.error || null,recoveryRequired:recoveryRequired(task),
    unsentInputCount:task.unsentInputs?.length || 0,
    unsentInputs:(task.unsentInputs || []).slice(-3).map(row=>({id:row.id,text:row.text.slice(0,2000),truncated:row.text.length>2000})),
    pendingRequests:pending(task).map(request=>({id:request.id,method:request.method})),
  }));
  return {language,connection,connected,bridgeRunning,tasks};
}
function serviceSnapshot({client,language,installed,selectedSpaceId,error}) {
  const spaces=(client?.spaces || []).map(space=>({spaceId:space.spaceId,label:space.root}));
  const spaceId=spaces.some(space=>space.spaceId===selectedSpaceId)?selectedSpaceId:spaces[0]?.spaceId || null;
  const projection=client?.snapshots.get(spaceId);
  return {language,serviceMode:true,bridgeRunning:!!client?.peer && !client.peer.closed,
    configurationAvailable:!!installed,spaces,spaceId,error:error || null,
    tasks:projection?.tasks || [],totalTasks:projection?.totalTasks || 0,hasMoreHistory:!!projection?.hasMoreHistory,
    taskChatsAvailable:false};
}
module.exports={readRecords,snapshot,serviceSnapshot};
