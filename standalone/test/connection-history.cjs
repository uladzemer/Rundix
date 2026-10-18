const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {SessionStore}=require('../runtime/store.cjs');
const {copyHistory}=require('../runtime/connection-history.cjs');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-history-'));
try {
  const store=new SessionStore(directory);
  const original={key:'old-session',id:'old-thread',name:'Synthetic draft',draft:'Keep this draft',items:[],attachments:[],followUps:[{id:'queued',text:'Keep this task'}],updatedAt:1234};
  const snapshot={sessions:[original],metadata:[{id:'old-thread',value:{group:'Synthetic group'}}]};
  assert.deepEqual(copyHistory(store,snapshot),{imported:1,unchanged:0,conflicts:0,metadataImported:1});
  assert.equal(store.session(original.key).updatedAt,1234);
  assert.equal(store.session(original.key).followUps[0].text,'Keep this task');
  assert.equal(copyHistory(store,snapshot).unchanged,1);
  assert.equal(copyHistory(store,{sessions:[{...original,key:'same-thread-new-key'}],metadata:[]}).conflicts,1);
  assert.equal(store.session('same-thread-new-key'),null);
  store.saveSession({...store.session(original.key),draft:'Newer draft'});
  assert.equal(copyHistory(store,snapshot).conflicts,1);
  assert.equal(store.session(original.key).draft,'Newer draft');
  fs.writeFileSync(store.file('session','damaged'),'{broken');
  assert.equal(copyHistory(store,{sessions:[{...original,key:'damaged'}],metadata:[]}).conflicts,1);
  assert.equal(fs.readFileSync(store.file('session','damaged'),'utf8'),'{broken');
  assert.throws(()=>copyHistory(store,{sessions:[{...original,key:'../outside'}],metadata:[]}));
  assert.equal(original.draft,'Keep this draft');
  console.log('PASS: history import preserves drafts/queue/time, retries idempotently, keeps newer or damaged targets and validates keys.');
} finally {fs.rmSync(directory,{recursive:true,force:true});}
