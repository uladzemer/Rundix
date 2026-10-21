const {randomUUID} = require('node:crypto');
const text = (value, max) => typeof value === 'string' && value.length <= max;
function project(value) {
  if (value === null) return null;
  if (!value || !text(value.title,100) || !Array.isArray(value.items) || value.items.length > 32) throw Error('Invalid connection menu.');
  const ids = new Set();
  return {title:value.title,items:value.items.map(item => {
    if (!item || !text(item.id,128) || !item.id || ids.has(item.id) || !text(item.label,256) || !item.label ||
      (item.detail !== undefined && !text(item.detail,256))) throw Error('Invalid connection menu.');
    ids.add(item.id);
    if (item.quota !== undefined && (!Array.isArray(item.quota) || item.quota.length > 4 || item.quota.some(quota => !quota || !text(quota.label,32) || !Number.isFinite(quota.remaining) || quota.remaining < 0 || quota.remaining > 100 || (quota.resetAt !== undefined && quota.resetAt !== null && (!Number.isFinite(quota.resetAt) || quota.resetAt <= 0 || quota.resetAt > 8640000000000))))) throw Error('Invalid connection menu.');
    return {id:item.id,label:item.label,detail:item.detail || '',quota:item.quota?.map(quota=>({label:quota.label,remaining:quota.remaining,resetAt:quota.resetAt ?? null})),checked:item.checked === true,disabled:item.disabled === true};
  })};
}
function bounded(read, timeout) {
  let timer;
  return Promise.race([Promise.resolve().then(read),new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error('Connection menu timed out.')),timeout);
  })]).finally(()=>clearTimeout(timer));
}
class ConnectionMenu {
  constructor(registry, timeout=12000) { this.registry=registry;this.timeout=timeout;this.sequence=0;this.current=null; }
  clear() { this.sequence++;this.current=null; }
  snapshot() {
    if (!this.current) return null;
    try { this.registry.assertCurrent(this.current.owner); }
    catch { return null; }
    return this.current.value;
  }
  async refresh(onLoading=()=>{}) {
    const sequence=++this.sequence;
    this.current=null;
    const owner=await this.registry.resolve();
    if (this.sequence!==sequence) return;
    if (!owner.provider?.readMenu) return;
    this.current={owner,value:{loading:true}};
    onLoading();
    try {
      const value=project(await bounded(()=>owner.provider.readMenu(),this.timeout));
      this.registry.assertCurrent(owner);
      if (this.sequence===sequence) this.current=value ? {owner,value:{...value,revision:randomUUID()}} : null;
    } catch {
      try { this.registry.assertCurrent(owner); }
      catch { return; }
      if (this.sequence===sequence) this.current={owner,value:{error:true}};
    }
  }
  async run(revision,id) {
    const menu=this.current;
    this.registry.assertCurrent(menu?.owner || {});
    if (!menu || menu.value.revision!==revision || !menu.value.items?.some(item=>item.id===id && !item.disabled))
      throw Error('Connection menu changed. Open it again.');
    this.clear();
    // Mutations are not raced against a timeout: the provider must bound its
    // operation, and the host credential lease stays held until it completes.
    const outcome=await menu.owner.provider.runMenuAction(id);
    this.registry.assertCurrent(menu.owner);
    return outcome;
  }
}
module.exports={ConnectionMenu,project};
