const LIMIT=100;
function history(session) {
  const rows=Array.isArray(session?.turnSelections)?session.turnSelections:session?.lastSelection?[session.lastSelection]:[];
  // A damaged stored record must not break saving or publishing the chat.
  return rows.filter(row=>row && typeof row.turnId==='string' && typeof row.model==='string').slice(-LIMIT).map(({turnId,model,displayName,effort})=>({turnId,model,displayName,effort}));
}
function append(session,selection) {
  return [...history(session).filter(row=>row.turnId!==selection.turnId),{...selection}].slice(-LIMIT);
}
module.exports={history,append};
