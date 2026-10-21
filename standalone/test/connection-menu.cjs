const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ConnectionMenu,project}=require('../runtime/connection-menu.cjs');
function fixture(readMenu) {
  const provider={readMenu,runMenuAction:async id=>id};
  let revision=1;
  const registry={resolve:async()=>({revision,provider}),assertCurrent:owner=>{if(owner.revision!==revision || owner.provider!==provider)throw Error('changed');}};
  return {menu:new ConnectionMenu(registry,20),change:()=>revision++,provider};
}
const value=()=>({title:'Synthetic choices',items:[{id:'one',label:'Synthetic item',secret:'synthetic-private'}],secret:'synthetic-private'});
test('menu publishes only bounded presentation fields and actions reject stale/forged revisions',async()=>{
  const f=fixture(value);await f.menu.refresh();const menu=f.menu.snapshot();
  assert.equal(JSON.stringify(menu).includes('synthetic-private'),false);
  assert.equal(await f.menu.run(menu.revision,'one'),'one');
  await assert.rejects(f.menu.run(menu.revision,'one'));
  await f.menu.refresh();await assert.rejects(f.menu.run('forged','one'));
  assert.throws(()=>project({title:'Bad',items:[{id:'one',label:'One'},{id:'one',label:'Duplicate'}]}));
  assert.throws(()=>project({title:'Bad',items:[{id:'one',label:'One',quota:[{label:'5ч',remaining:50,resetAt:-1}]}]}));
});
test('hidden, failed and timed out reads discard previous presentation',async()=>{
  const f=fixture(value);await f.menu.refresh();
  f.provider.readMenu=()=>null;await f.menu.refresh();assert.equal(f.menu.snapshot(),null);
  f.provider.readMenu=()=>{throw Error('synthetic-private');};await f.menu.refresh();assert.deepEqual(f.menu.snapshot(),{error:true});
  f.provider.readMenu=()=>new Promise(()=>{});await f.menu.refresh();assert.deepEqual(f.menu.snapshot(),{error:true});
});
test('late reads from a replaced selection cannot publish or run actions',async()=>{
  let finish;
  const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  const read=f.menu.refresh();await new Promise(resolve=>setImmediate(resolve));
  f.change();finish(value());await read;assert.equal(f.menu.snapshot(),null);
});
test('concurrent refresh keeps only the newest result',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  const first=f.menu.refresh();await new Promise(resolve=>setImmediate(resolve));
  f.provider.readMenu=()=>null;await f.menu.refresh();finish(value());await first;
  assert.equal(f.menu.snapshot(),null);
});
