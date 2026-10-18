// Metadata owned by this extension only. Codex transcripts remain in the CLI profile.
class SessionLibrary {
 constructor(storage,shared){this.storage=storage;this.shared=shared;this.closed=storage.get('closed',[]);this.meta=storage.get('metadata',{});this.last=storage.get('last',null);this.defaults=storage.get('defaults',{});this.queue=Promise.resolve();}
 write(key,value){const snapshot=JSON.parse(JSON.stringify(value));this.queue=this.queue.catch(()=>{}).then(()=>this.storage.update(key,snapshot));return this.queue;}
 identity(session){return session.id||session.key;}
 get(session){return {...this.meta[this.identity(session)],...this.shared?.meta(this.identity(session))};}
 update(session,change){const id=this.identity(session);this.meta[id]={...this.get(session),...change};this.shared?.updateMeta(id,change);return this.write('metadata',this.meta);}
 migrate(key,id){const old={...this.meta[key],...this.shared?.meta(key)};this.meta[id]={...old,...this.meta[id],...this.shared?.meta(id)};if(Object.keys(this.meta[id]).length)this.shared?.updateMeta(id,this.meta[id]);delete this.meta[key];return this.write('metadata',this.meta);}
 close(session,column){this.closed=this.closed.filter(entry=>entry.key!==session.key);this.closed.push({key:session.key,name:session.name,id:session.id,column});this.closed=this.closed.slice(-30);return this.write('closed',this.closed);}
 async pop(){const entry=this.closed.pop();await this.write('closed',this.closed);return entry;}
 touch(session,column){this.last={key:session.key,id:session.id,name:session.name,column};return this.write('last',this.last);}
 setDefaults(value){this.defaults={...this.defaults,...value};return this.write('defaults',this.defaults);}
 decorate(rows){return rows.map(row=>({...row,...this.get(row)}));}
 bookmarks(session){return Object.entries(this.get(session)).filter(([key,value])=>key.startsWith('bookmark:')&&value&&typeof value.text==='string').map(([,value])=>value).sort((a,b)=>b.createdAt-a.createdAt);}
 setBookmark(session,item,enabled){const key='bookmark:'+item.id,existing=this.get(session)[key];return this.update(session,{[key]:enabled?{id:item.id,turnId:item.turnId,text:item.text,title:item.text.replace(/\s+/g,' ').slice(0,120),createdAt:existing?.createdAt||Date.now()}:null});}
}
module.exports={SessionLibrary};
