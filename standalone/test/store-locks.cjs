// Lock robustness on hostile file systems: no hard links, busy handles, stuck record locks.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SessionStore}=require('../runtime/store.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-store-locks-synthetic-'));
const original={link:fs.linkSync,unlink:fs.unlinkSync};
try{
  const store=new SessionStore(path.join(root,'records'));

  // A volume without hard links still gets exclusive leases.
  fs.linkSync=()=>{throw Object.assign(Error('synthetic no hard links'),{code:'EPERM'});};
  const release=store.acquire('synthetic-lease');
  assert.throws(()=>store.acquire('synthetic-lease'),/другом окне|another window/);
  release();
  const again=store.acquire('synthetic-lease');again();
  store.saveSession({key:'synthetic-session',draft:'synthetic draft'});
  assert.equal(store.session('synthetic-session').draft,'synthetic draft');
  fs.linkSync=original.link;

  // A busy temp file (antivirus) must not hide an acquired lease or its release function.
  fs.unlinkSync=file=>{if(String(file).endsWith('.tmp'))throw Object.assign(Error('synthetic busy'),{code:'EBUSY'});return original.unlink(file);};
  const busyRelease=store.acquire('synthetic-busy');
  assert.equal(typeof busyRelease,'function');busyRelease();
  fs.unlinkSync=original.unlink;
  assert.doesNotThrow(()=>store.acquire('synthetic-busy')());

  // A record lock left by a live pid (reused pid or hung owner) expires by age.
  const lock=store.file('record-session','synthetic-stuck');
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,nonce:'synthetic-stuck'}));
  const old=new Date(Date.now()-60000);fs.utimesSync(lock,old,old);
  store.saveSession({key:'synthetic-stuck',draft:'saved despite stuck lock'});
  assert.equal(store.session('synthetic-stuck').draft,'saved despite stuck lock');

  // Leases held by a live pid never expire by age: a long Codex turn keeps its lease.
  const lease=store.file('lease','synthetic-long-turn');
  fs.writeFileSync(lease,JSON.stringify({pid:process.pid,nonce:'synthetic-turn'}));fs.utimesSync(lease,old,old);
  assert.throws(()=>store.acquire('synthetic-long-turn'));
  console.log('PASS: leases without hard links, busy temp cleanup, aged record locks and long-lived turn leases.');
}finally{fs.linkSync=original.link;fs.unlinkSync=original.unlink;fs.rmSync(root,{recursive:true,force:true});}
