const LIMIT=100;
function steeredTurns(session) {
  return [...new Set((Array.isArray(session?.steeredTurns)?session.steeredTurns:[]).filter(id=>typeof id==='string').reverse())].slice(0,LIMIT).reverse();
}
function history(session) {
  const rows=Array.isArray(session?.turnSelections)?session.turnSelections:session?.lastSelection?[session.lastSelection]:[];
  const steered=new Set(steeredTurns(session));
  // A damaged stored record must not break saving or publishing the chat.
  return rows.filter(row=>row && typeof row.turnId==='string' && typeof row.model==='string').slice(-LIMIT).map(({turnId,model,displayName,effort,steered:marked})=>({turnId,model,displayName,effort,...(marked===true || steered.has(turnId)?{steered:true}:{})}));
}
function append(session,selection) {
  const rows=history(session),marked=steeredTurns(session).includes(selection.turnId) || rows.some(row=>row.turnId===selection.turnId && row.steered);
  return [...rows.filter(row=>row.turnId!==selection.turnId),{...selection,...(marked?{steered:true}:{})}].slice(-LIMIT);
}
function markSteered(session,turnId) {
  if(!session.mcpTask || typeof turnId!=='string')return;
  const rows=history(session);
  session.steeredTurns=[...steeredTurns(session).filter(id=>id!==turnId),turnId].slice(-LIMIT);
  // Retain known ambiguity even after its ID leaves the independent bounded list.
  session.turnSelections=rows.map(row=>row.turnId===turnId?{...row,steered:true}:row);
}
module.exports={history,append,steeredTurns,markSteered};
