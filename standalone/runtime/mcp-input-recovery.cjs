const {randomUUID}=require('node:crypto');
const MAX_ENTRIES=50,MAX_BYTES=2*1024*1024;
function prune(task) {
  const rows=task.unsentInputs || [];
  let bytes=Buffer.byteLength(JSON.stringify(rows));
  while(rows.length>MAX_ENTRIES || bytes>MAX_BYTES){rows.shift();bytes=Buffer.byteLength(JSON.stringify(rows));}
}
function remember(task,text) {
  task.unsentInputs ||= [];
  if(!task.unsentInputs.some(row=>row.text===text))task.unsentInputs.push({id:randomUUID(),text});
  prune(task);
}
function delivered(task,text) {
  if(task.unsentInputs)task.unsentInputs=task.unsentInputs.filter(row=>row.text!==text);
}
function page(task,after) {
  const rows=task.unsentInputs || [],start=after?rows.findIndex(row=>row.id===after)+1:0;
  const selected=[];let bytes=0;
  for(const row of rows.slice(start)){
    const size=Buffer.byteLength(JSON.stringify(row));
    if(selected.length && (selected.length>=10 || bytes+size>512000))break;
    selected.push(row);bytes+=size;
  }
  return {unsentInputs:selected,unsentInputCount:rows.length,
    nextUnsentCursor:start+selected.length<rows.length?selected.at(-1).id:null};
}
module.exports={remember,delivered,page,prune,MAX_ENTRIES,MAX_BYTES};
