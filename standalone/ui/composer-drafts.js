// Remember whether cached text still belongs to a host snapshot or was edited
// locally. Persist this alongside the text: a one-shot `sent` can be missed
// while the webview is unloaded, but the next host snapshot is authoritative.
class WorkbenchComposerDrafts {
  constructor(saved={}) { this.records={...saved}; }
  edit(key) {
    const record=this.records[key] || {};
    this.records[key]={...record,owned:false,awaitingClear:false,version:(record.version || 0)+1};
  }
  submit(key,text) {
    const record=this.records[key] || {owned:false,version:0};
    this.records[key]={...record,submitted:{text,version:record.version}};
  }
  receive(key,local,host='') {
    const record=this.records[key];
    const submitted=record?.submitted;
    const delivered=!!submitted && record.host===submitted.text && host==='';
    const consumed=delivered && submitted.version===record.version && local===submitted.text;
    const owned=local===undefined || !record && !local ||
      record?.owned && local===record.host || consumed ||
      record?.awaitingClear && host==='' && local==='';
    this.records[key]={...record,host,owned:!!owned,
      awaitingClear:!!record?.awaitingClear && host!=='',
      ...(delivered?{submitted:undefined}:{})};
    return {text:owned?host:local,delivered};
  }
  canConsume(key,text,local) {
    const record=this.records[key];
    return local===text && !!record && (record.owned && record.host===text ||
      record.submitted?.text===text && record.submitted.version===record.version);
  }
  consumed(key) {
    // Also protect the cleared input from a late pre-delivery snapshot.
    const record=this.records[key] || {};
    this.records[key]={...record,owned:false,awaitingClear:true,submitted:undefined};
  }
  prune(activeKey,openKeys,drafts) {
    const open=Array.isArray(openKeys)?new Set(openKeys):null;
    const forget=key=>{
      const record=this.records[key];
      // Host snapshots can be reloaded; never discard independently edited text.
      if(record.owned && drafts[key]===record.host)delete drafts[key];
      delete this.records[key];
    };
    for(const [key,record] of Object.entries(this.records)){
      if(key===activeKey)continue;
      if(open && !open.has(key) || record.host==='' && !drafts[key] && !record.submitted && !record.awaitingClear)forget(key);
    }
    const keys=Object.keys(this.records).filter(key=>key!==activeKey);
    if(this.records[activeKey])keys.push(activeKey);
    let count=0,characters=0;
    for(const key of keys.reverse()){
      const record=this.records[key],size=(record.host?.length || 0)+(record.submitted?.text?.length || 0);
      if(count>=64 || characters+size>1000000)forget(key);
      else {count++;characters+=size;}
    }
  }
}
globalThis.WorkbenchComposerDrafts=WorkbenchComposerDrafts;
