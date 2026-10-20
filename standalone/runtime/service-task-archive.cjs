// Service-only closed-task history. Records and idempotency indexes stay local;
// archiving never deletes a chat or makes an old requestId executable again.
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {SessionStore}=require('./store.cjs');
const failure=()=>Object.assign(Error('Task archive is unavailable.'),{code:'storage_unavailable'});
class TaskArchive {
  constructor(store,{log=()=>{}}={}){
    this.active=store;this.store=new SessionStore(path.join(store.directory,'archive'));this.log=log;this.index=new Map();this.spaces=new Map();
    const saved=this.store.read('view','index');
    if(saved?.schemaVersion===1 && Array.isArray(saved.rows) && saved.rows.every(row=>this.validIndex(row))){
      for(const row of saved.rows)this.index.set(row.taskId,row);this.group();
    }else{
      if(fs.existsSync(this.store.file('view','index')))this.notice('archive_index_corrupt');
      for(const name of fs.readdirSync(this.store.directory))if(/^mcp-task-[\w-]+\.json$/.test(name)){
        const id=name.slice(9,-5);try{const task=this.get(id);if(task)this.index.set(id,this.entry(task));}catch{this.notice('archive_record_corrupt');}
      }
      this.group();this.persist();
    }
  }
  notice(code){try{this.log({code});}catch{}}
  validIndex(row){return row && /^[\w-]{1,128}$/.test(row.taskId) && typeof row.space==='string' && Number.isFinite(row.createdAt) && Number.isFinite(row.size) && Number.isFinite(row.mtimeMs) && row.summary?.taskId===row.taskId && typeof row.summary.description==='string' && ['completed','error','cancelled'].includes(row.summary.state);}
  group(){
    this.spaces.clear();for(const row of this.index.values()){if(!this.spaces.has(row.space))this.spaces.set(row.space,[]);this.spaces.get(row.space).push(row);}
    for(const rows of this.spaces.values())rows.sort((a,b)=>b.createdAt-a.createdAt || a.taskId.localeCompare(b.taskId));
  }
  persist(){this.store.write('view','index',{schemaVersion:1,rows:[...this.index.values()]});}
  entry(task){
    const stat=fs.statSync(this.store.file('mcp-task',task.taskId));
    const summary={taskId:task.taskId,space:task.space,description:(task.description || '').slice(0,160),state:task.state,progress:(task.progress || '').slice(0,2000),
      chatId:task.chatId || null,projectDirectory:task.projectDirectory,createdAt:task.createdAt,updatedAt:task.updatedAt,revision:task.revision || 0,closedAt:task.closedAt,
      report:require('./service-projection.cjs').report(task.report),error:(task.error || '').slice(0,1000) || null,unsentInputCount:task.unsentInputs?.length || 0};
    return {taskId:task.taskId,space:task.space,createdAt:task.createdAt || 0,size:stat.size,mtimeMs:stat.mtimeMs,summary};
  }
  page(space,{limit=100,exclude=new Set()}={}){
    const rows=this.spaces.get(space) || [],tasks=[];let dirty=false,examined=0;
    for(const row of rows){
      if(tasks.length>=limit || examined++>=limit+exclude.size+100)break;if(exclude.has(row.taskId))continue;
      try{
        const stat=fs.statSync(this.store.file('mcp-task',row.taskId));
        if(stat.size!==row.size || stat.mtimeMs!==row.mtimeMs){
          const task=this.get(row.taskId);if(!task || task.space!==space)throw failure();
          const updated=this.entry(task);this.index.set(row.taskId,updated);Object.assign(row,updated);dirty=true;
        }
        tasks.push({...row.summary,archived:true});
      }catch{this.index.delete(row.taskId);dirty=true;this.notice('archive_record_corrupt');}
    }
    if(dirty){this.group();try{this.persist();}catch{this.notice('archive_index_unavailable');}}
    let total=(this.spaces.get(space) || []).length;for(const id of exclude)if(this.index.get(id)?.space===space)total--;
    return {tasks,total};
  }
  read(kind,id){
    if(typeof id!=='string' || !/^[\w-]{1,128}$/.test(id))return null;
    const record=this.store.read(kind,id);
    if(!record && fs.existsSync(this.store.file(kind,id)))throw failure();
    return record;
  }
  get(id){const task=this.read('mcp-task',id);if(task && (task.taskId!==id || typeof task.space!=='string' || !Array.isArray(task.operations)))throw failure();return task;}
  *records(){
    for(const name of fs.readdirSync(this.store.directory)) {
      if(!/^mcp-task-[\w-]+\.json$/.test(name))continue;
      const task=this.get(name.slice(9,-5));
      if(!task || task.taskId!==name.slice(9,-5) || typeof task.space!=='string' || !Array.isArray(task.operations))throw failure();
      yield task;
    }
  }
  request(space,id){
    const key=createHash('sha256').update(space+'\0'+id).digest('hex');
    const row=this.read('request',key);if(!row)return null;
    const task=this.get(row.taskId);
    if(!task || task.space!==space)throw failure();
    const operation=task.operations.find(value=>value.requestId===id);
    if(!operation)throw failure();
    return {task,operation};
  }
  put(task){
    this.store.write('mcp-task',task.taskId,task);
    for(const op of task.operations) {
      const key=createHash('sha256').update(task.space+'\0'+op.requestId).digest('hex');
      this.store.write('request',key,{taskId:task.taskId});
    }
    this.index.set(task.taskId,this.entry(task));this.group();this.persist();
    // Source removal is last. A crash before it leaves an active duplicate;
    // active records take precedence and remain safe for idempotent retries.
    try{fs.unlinkSync(this.active.file('mcp-task',task.taskId));}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  restored(task){
    // Keep the archival copy/index for crash-safe dedup; active records win.
    delete task.closedAt;
  }
}
module.exports={TaskArchive};
