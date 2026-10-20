const {randomUUID}=require('node:crypto');
// Each task already caps accepted operations at 1000. Keep distinct definite
// refusals separately from nextInput; a new request must not erase recovery.
function remember(task,text) {
  task.unsentInputs ||= [];
  if(!task.unsentInputs.some(row=>row.text===text))task.unsentInputs.push({id:randomUUID(),text});
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
module.exports={remember,delivered,page};
