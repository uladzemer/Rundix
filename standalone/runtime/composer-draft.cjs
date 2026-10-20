const {randomUUID}=require('node:crypto');
const snapshot=s=>({text:s.draft || '',revision:s.draftRevision || null});
const unchanged=(s,draft)=>!!draft && (s.draft || '')===draft.text && (s.draftRevision || null)===draft.revision;
const hostOwned=s=>unchanged(s,s.executorDraft);
function userEdit(s,text,{explicit=false}={}) {
  if(explicit || s.draft!==text){s.draftRevision=randomUUID();delete s.executorDraft;}
  s.draft=text;
}
function prepare(s,text) {
  if(s.draft && !hostOwned(s))return false;
  s.draft=text;s.draftRevision=randomUUID();s.executorDraft=snapshot(s);
  return true;
}
function consume(s,draft) {
  if(!unchanged(s,draft))return false;
  s.draft='';s.draftRevision=randomUUID();delete s.executorDraft;
  return true;
}
module.exports={snapshot,unchanged,hostOwned,userEdit,prepare,consume};
