// Service-only closed-task history. Records and idempotency indexes stay local;
// archiving never deletes a chat or makes an old requestId executable again.
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {SessionStore}=require('./store.cjs');
const failure=()=>Object.assign(Error('Task archive is unavailable.'),{code:'storage_unavailable'});
class TaskArchive {
  constructor(store){this.active=store;this.store=new SessionStore(path.join(store.directory,'archive'));}
  read(kind,id){
    if(typeof id!=='string' || !/^[\w-]{1,128}$/.test(id))return null;
    const record=this.store.read(kind,id);
    if(!record && fs.existsSync(this.store.file(kind,id)))throw failure();
    return record;
  }
  get(id){return this.read('mcp-task',id);}
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
