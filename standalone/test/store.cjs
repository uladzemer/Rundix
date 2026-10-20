const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');const {execFileSync,spawn}=require('node:child_process');const {SessionStore}=require('../runtime/store.cjs');const {SessionLibrary}=require('../runtime/library.cjs');
const pause=new Int32Array(new SharedArrayBuffer(4));
function waitFor(predicate){const deadline=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<deadline,'Synthetic interleaving timed out');Atomics.wait(pause,0,0,5);}}
async function concurrentMerge(directory,kind){
 const a=new SessionStore(directory),key='race-'+kind;
 const baseline=kind==='session'?a.saveSession({key,name:'Synthetic original',draft:'Synthetic baseline'}):a.updateMeta(key,{group:'Synthetic group',unread:false});
 const marker=path.join(directory,key+'.marker'),done=path.join(directory,key+'.done');
 let child;
 const read=a.read;
 a.read=function(recordKind,id){
  const previous=read.call(this,recordKind,id);
  if(recordKind===kind&&id===key){
   this.read=read;
   // Start a second host after this host has read the revision, but before it writes.
   child=spawn(process.execPath,['-e',`
    const fs=require('node:fs'),{SessionStore}=require(process.argv[1]);
    const [directory,kind,key,marker,done]=process.argv.slice(2),b=new SessionStore(directory);
    const baseline=kind==='session'?b.session(key):null,link=fs.linkSync;
    fs.linkSync=function(source,target){try{return link(source,target);}catch(error){if(error.code==='EEXIST'&&target===b.file('record-'+kind,key))fs.writeFileSync(marker,'contended');throw error;}};
    if(kind==='session')b.saveSession({...baseline,draft:'Synthetic newer draft'},baseline);else b.updateMeta(key,{unread:true});
    fs.writeFileSync(done,'done');
   `,require.resolve('../runtime/store.cjs'),directory,kind,key,marker,done],{stdio:'ignore'});
   waitFor(()=>fs.existsSync(marker)||fs.existsSync(done));
  }
  return previous;
 };
 try{
  if(kind==='session')a.saveSession({...baseline,name:'Synthetic renamed'},baseline);else a.updateMeta(key,{group:'Synthetic renamed group'});
  assert.ok(child,'Second host started');
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Synthetic writer failed: '+code)));});
  const result=kind==='session'?a.session(key):a.meta(key);
  if(kind==='session'){assert.equal(result.draft,'Synthetic newer draft');assert.equal(result.name,'Synthetic renamed');}
  else{assert.equal(result.unread,true);assert.equal(result.group,'Synthetic renamed group');}
  assert.ok(fs.existsSync(marker),'Second host contended on the record lock');
 }finally{a.read=read;if(child&&child.exitCode===null)child.kill();}
}
(async()=>{
 const root=path.resolve(__dirname,'../.verification');fs.mkdirSync(root,{recursive:true});const directory=fs.mkdtempSync(path.join(root,'store-'));const a=new SessionStore(directory),b=new SessionStore(directory);
 const baseline=a.saveSession({key:'draft-a',name:'Draft',draft:'Unsent',cwd:path.join(directory,'project-a'),items:[],prefs:{focus:false}});
 const local=b.session('draft-a');b.saveSession({...local,draft:'New draft in another window'},local);const merged=a.saveSession({...baseline,name:'Renamed'},baseline);assert.equal(merged.draft,'New draft in another window');assert.equal(merged.name,'Renamed');
 execFileSync(process.execPath,['-e','const {SessionStore}=require(process.argv[1]);const s=new SessionStore(process.argv[2]);const r=s.session("draft-a");if(r.draft!=="New draft in another window")process.exit(2);s.saveSession({...r,draft:"From another process"},r);',require.resolve('../runtime/store.cjs'),directory]);assert.equal(a.session('draft-a').draft,'From another process');
 a.saveSession({key:'draft-b',name:'Other project',cwd:path.join(directory,'project-b'),items:[]});assert.equal(a.list(path.join(directory,'project-a')).length,1);assert.equal(a.list().length,2);
 const storage=()=>({get:(_key,fallback)=>fallback,update:async()=>{}});const first=new SessionLibrary(storage(),a),second=new SessionLibrary(storage(),b);await first.update({key:'draft-a'},{group:'Architecture'});assert.equal(second.get({key:'draft-a'}).group,'Architecture');await second.update({key:'draft-a'},{unread:true});assert.equal(first.get({key:'draft-a'}).unread,true);
 await first.setBookmark({key:'draft-a'},{id:'response-a',text:'Keep this answer',turnId:'turn-a'},true);await second.setBookmark({key:'draft-a'},{id:'response-b',text:'Another answer'},true);assert.equal(first.bookmarks({key:'draft-a'}).length,2);await first.setBookmark({key:'draft-a'},{id:'response-a'},false);assert.equal(second.bookmarks({key:'draft-a'})[0].text,'Another answer');const reloaded=new SessionLibrary(storage(),new SessionStore(directory));assert.equal(reloaded.bookmarks({key:'draft-a'})[0].id,'response-b');await reloaded.migrate('draft-a','saved-thread');assert.equal(reloaded.bookmarks({id:'saved-thread'}).length,1);
 const release=a.acquire('thread-fixture');assert.throws(()=>b.acquire('thread-fixture'),/другом окне/);release();b.acquire('thread-fixture')();
 // Observe publication at the exact filesystem boundary. Both hosts must see complete JSON.
 const link=fs.linkSync,leaseTarget=a.file('lease','atomic-fixture');let observed=false;
 fs.linkSync=function(source,target){const result=link(source,target);if(target===leaseTarget){observed=true;assert.equal(JSON.parse(fs.readFileSync(target,'utf8')).pid,process.pid);assert.throws(()=>b.acquire('atomic-fixture'),/другом окне/);}return result;};
 let atomicRelease;try{atomicRelease=a.acquire('atomic-fixture');}finally{fs.linkSync=link;atomicRelease?.();}assert.ok(observed);
 // A legacy writer may have opened the lease and not yet completed its JSON.
 for(const partial of ['', '{"pid":']){
  const target=a.file('lease','partial-fixture');fs.writeFileSync(target,partial);
  assert.throws(()=>b.acquire('partial-fixture'),/другом окне/);assert.equal(fs.readFileSync(target,'utf8'),partial);
  const old=new Date(Date.now()-120000);fs.utimesSync(target,old,old);b.acquire('partial-fixture')();
 }
 // Only ESRCH proves a valid owner dead; permission errors must fail closed.
 const kill=process.kill;try{
  fs.writeFileSync(a.file('lease','dead-fixture'),JSON.stringify({pid:2147483647,nonce:'synthetic-dead'}));
  process.kill=(pid,signal)=>{if(pid===2147483647)throw Object.assign(Error('Synthetic dead owner'),{code:'ESRCH'});return kill(pid,signal);};b.acquire('dead-fixture')();
  // Recover a crash during stale removal, including its abandoned guard.
  const abandoned=a.file('lease','abandoned-fixture'),guard=abandoned+'.reap',owner='2147483647-00000000-0000-0000-0000-000000000001';
  fs.writeFileSync(abandoned,JSON.stringify({pid:2147483647,nonce:'synthetic-abandoned'}));fs.mkdirSync(guard);fs.writeFileSync(path.join(guard,owner),'');b.acquire('abandoned-fixture')();assert.ok(!fs.existsSync(guard));
  // Re-enter after stale deletion: the losing reaper must not unlink a new owner.
  const raced=a.file('lease','reaper-fixture'),unlink=fs.unlinkSync;let winner;
  fs.writeFileSync(raced,JSON.stringify({pid:2147483647,nonce:'synthetic-stale'}));
  fs.unlinkSync=function(target){const result=unlink(target);if(target===raced&&!winner)winner=b.acquire('reaper-fixture');return result;};
  try{assert.throws(()=>a.acquire('reaper-fixture'),/другом окне/);assert.equal(a.read('lease','reaper-fixture').pid,process.pid);}finally{fs.unlinkSync=unlink;winner?.();}
  fs.writeFileSync(a.file('lease','denied-fixture'),JSON.stringify({pid:2147483647,nonce:'synthetic-denied'}));
  process.kill=()=>{throw Object.assign(Error('Synthetic permission error'),{code:'EPERM'});};assert.throws(()=>b.acquire('denied-fixture'),/другом окне/);
 }finally{process.kill=kill;fs.unlinkSync(a.file('lease','denied-fixture'));}
 await concurrentMerge(directory,'session');await concurrentMerge(directory,'meta');
 // A failed write releases its lock and leaves the previous draft intact.
 const write=a.write;a.write=()=>{throw Error('Synthetic write failure');};try{assert.throws(()=>a.saveSession({...baseline,draft:'Synthetic failed draft'},baseline),/Synthetic write failure/);}finally{a.write=write;}
 assert.equal(b.session('draft-a').draft,'From another process');b.saveSession({...baseline,name:'Recovered'},baseline);
 const busy=a.file('record-meta','busy-fixture');fs.writeFileSync(busy,JSON.stringify({pid:process.pid,nonce:'synthetic-busy'}));
 const started=Date.now();try{assert.throws(()=>b.updateMeta('busy-fixture',{unread:true}),/busy/);assert.ok(Date.now()-started<5000);assert.deepEqual(a.meta('busy-fixture'),{});}finally{fs.unlinkSync(busy);}
 assert.ok(!fs.readdirSync(directory).some(name=>name.startsWith('record-')||name.endsWith('.reap')));
 console.log('PASS: atomic lease publication, partial-lease grace, dead-owner recovery, cross-process session/meta interleavings and failed-write recovery.');
 a.saveHost({hostKey:'host-a',keys:['draft-a','draft-b'],activeKey:'draft-b'});assert.equal(b.host('host-a').activeKey,'draft-b');assert.throws(()=>a.session('../outside'));assert.ok(!fs.readdirSync(directory).some(name=>name.endsWith('.tmp')));
 const imported={key:'imported-fork',id:'thread-fork',name:'Branch',items:[]};assert.equal(a.saveSession(imported,imported).id,'thread-fork');
 console.log('PASS: persistence across independent processes, stale-window field merge, project filtering, shared groups/unread, host restoration, turn lease and path boundaries.');
})().catch(error=>{console.error(error);process.exitCode=1});
