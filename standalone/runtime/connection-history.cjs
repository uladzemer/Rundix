// Copy only extension-owned conversation metadata. Source records are never deleted.
const {randomUUID} = require('node:crypto');
const KEY = /^[a-zA-Z0-9_-]{1,128}$/;
const fields = ['key','id','name','customName','model','effort','prefs','draft','attachments','followUps','queuePaused','asyncQuestionReplies','questionHistory','preflight','cwd','parentId','items','tokenUsage','usageModel','usageStale'];
function sessionRecord(input) {
  if (!input || !KEY.test(input.key || '') || (input.id != null && !KEY.test(input.id)) ||
      typeof input.name !== 'string' || input.name.length > 200 ||
      (input.draft !== undefined && (typeof input.draft !== 'string' || input.draft.length > 200000)) ||
      (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd.length > 32768)) ||
      !Array.isArray(input.items) || input.items.length > 10000 ||
      (input.attachments !== undefined && !Array.isArray(input.attachments)) ||
      (input.followUps !== undefined && !Array.isArray(input.followUps)))
    throw Error('Invalid legacy session. No source data has been changed.');
  return Object.fromEntries(fields.filter(field => input[field] !== undefined).map(field => [field,input[field]]));
}
function copyHistory(store, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.sessions) || !Array.isArray(snapshot.metadata) ||
      snapshot.sessions.length > 5000 || snapshot.metadata.length > 10000 || JSON.stringify(snapshot).length > 64*1024*1024)
    throw Error('Invalid or oversized legacy history.');
  const sessions=snapshot.sessions.map(input => ({record:sessionRecord(input),updatedAt:Number.isFinite(input.updatedAt)?input.updatedAt:Date.now()}));
  const metadata=snapshot.metadata.map(entry => {
    if (!KEY.test(entry?.id || '') || !entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) throw Error('Invalid legacy history metadata.');
    return entry;
  });
  const result={imported:0,unchanged:0,conflicts:0,metadataImported:0};
  const knownSessions=store.list();
  for (const {record,updatedAt} of sessions) {
    if (record.id && knownSessions.some(existing => existing.id===record.id && existing.key!==record.key)) {
      result.conflicts++;continue;
    }
    const previous=store.session(record.key);
    // A damaged target file is a conflict, not permission to overwrite it.
    if (require('node:fs').existsSync(store.file('session',record.key))) {
      if (previous && JSON.stringify(sessionRecord(previous))===JSON.stringify(record)) result.unchanged++;
      else result.conflicts++;
      continue;
    }
    store.write('session',record.key,{...record,updatedAt,revision:randomUUID()});
    knownSessions.push(record);
    result.imported++;
  }
  for (const entry of metadata) {
    if (require('node:fs').existsSync(store.file('meta',entry.id))) continue;
    store.write('meta',entry.id,entry.value);result.metadataImported++;
  }
  return result;
}
module.exports={copyHistory};
