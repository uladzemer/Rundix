// All chat contents and sessions here are synthetic. Delivery scenarios omit
// sent; a separate stale acknowledgement checks preservation of user edits.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async({browser})=>{
 const scripts=[...fs.readFileSync(path.join(__dirname,'../extension.cjs'),'utf8').matchAll(/uri\("([^"/]+\.js)"\)/g)].map(match=>match[1]);
 for(const language of ['ru','en'])for(const light of [false,true])for(const width of [340,1000]){
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewport({width,height:850});
  const pending={key:'synthetic-continuation',hostKey:'synthetic-host',name:'Synthetic MCP chat',language,
   draft:'Synthetic continuation pending rotation',models:[],prefs:{},items:[],requests:[],attachments:[],followUps:[],busy:false};
  const delivered={...pending,draft:'',busy:true,items:[{id:'synthetic-sent',type:'userMessage',content:[{type:'text',text:pending.draft}]}]};
  const load=async(fixture,saved={})=>{
   await page.goto('about:blank');await page.setContent(`<html data-language="${language}"><body><main id="app"></main></body></html>`);
   await page.addStyleTag({content:fs.readFileSync(path.join(__dirname,'../ui/app.css'),'utf8')});
   await page.evaluate(({fixture,saved,light})=>{
    window.fixture=fixture;window.saved=saved;
    document.documentElement.style.setProperty('--vscode-editor-background',light?'#fff':'#1e1e1e');
    document.documentElement.style.setProperty('--vscode-foreground',light?'#333':'#ccc');
    window.update=()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',data:window.fixture}}));
    window.acquireVsCodeApi=()=>({getState:()=>window.saved,setState:state=>window.saved=state,postMessage:message=>{
     if(message.action==='ready')queueMicrotask(window.update);
    }});
   },{fixture,saved,light});
   for(const script of scripts)await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../ui',script),'utf8')});
   await page.evaluate(()=>window.update());
  };
  const value=()=>page.$eval('.composer textarea',node=>node.value);
  const update=fixture=>page.evaluate(fixture=>{window.fixture=fixture;window.update();},fixture);
  const edit=text=>page.$eval('.composer textarea',(node,text)=>{node.value=text;node.dispatchEvent(new Event('input',{bubbles:true}));},text);
  try{
   // Reopened chat hydrates while the executor prepares/rotates. Delivery's
   // acknowledgement is lost, but its subsequent state is received.
   await load(pending);assert.equal(await value(),pending.draft);
   const savedPending=await page.evaluate(()=>window.saved);
   await update(delivered);
   assert.equal(await value(),'','Open composer consumes the host-owned continuation without sent');
   // Webview was unloaded after hydration, and misses both the acknowledgement
   // and the cleared state. Its first new state has host draft:"".
   await load(delivered,savedPending);
   assert.equal(await value(),'','Recreated webview does not resurrect a delivered cached continuation');
   assert.equal(await page.evaluate(()=>window.saved.drafts[window.fixture.key]),'');
   // Internal tab switch caches the draft while the continuation is delivered.
   await load(pending);
   await update({...pending,key:'synthetic-other',draft:'Synthetic other chat draft'});
   await update(delivered);
   assert.equal(await value(),'','Key switch does not prefer stale localDrafts over host clearance');
   // Definite pre-send failure must remain recoverable, including recreation.
   await load(pending);await update({...pending,error:'Synthetic pre-send refusal'});
   assert.equal(await value(),pending.draft);
   await load({...pending,error:'Synthetic pre-send refusal'},await page.evaluate(()=>window.saved));
   assert.equal(await value(),pending.draft,'Failed continuation survives webview recreation');
   // A user editing host-injected input takes ownership, even if they later
   // restore exactly the original text. Text equality alone is insufficient.
   await edit('Synthetic unrelated user draft');
   const savedEdit=await page.evaluate(()=>window.saved);
   await update(delivered);assert.equal(await value(),'Synthetic unrelated user draft');
   await load(delivered,savedEdit);assert.equal(await value(),'Synthetic unrelated user draft');
   await load(pending);await edit('Synthetic intermediate user edit');await edit(pending.draft);
   await update(delivered);assert.equal(await value(),pending.draft,'User ownership survives editing back to equal text');
   await page.evaluate(text=>window.dispatchEvent(new MessageEvent('message',{data:{type:'sent',key:window.fixture.key,text}})),pending.draft);
   assert.equal(await value(),pending.draft,'A delayed sent also preserves user edits back to equal text');
   // Legacy setState has no ownership metadata: preserve it conservatively.
   await load(delivered,{key:pending.key,draft:'Synthetic legacy user draft',drafts:{[pending.key]:'Synthetic legacy user draft'}});
   assert.equal(await value(),'Synthetic legacy user draft');
   // Ordinary sends also observe a pre-send host draft. Its later clearance
   // consumes only that submission, even if the one-shot acknowledgement is lost.
   await load({...pending,draft:''});await edit(pending.draft);
   await page.click('.submit-button');
   await update(pending);
   const savedSubmission=await page.evaluate(()=>window.saved);
   await update(delivered);assert.equal(await value(),'','Ordinary submission is consumed by the confirmed host clearance');
   await edit('Synthetic next input');
   assert.equal(await page.$eval('.submit-button',node=>node.disabled),false,'Lost sent does not leave ordinary sending state stuck');
   await load(delivered,savedSubmission);assert.equal(await value(),'','Ordinary confirmed input stays consumed after recreation');
   await load({...pending,draft:''});await edit(pending.draft);await page.click('.submit-button');
   await update(pending);await edit('Synthetic edit during ordinary send');
   await update(delivered);
   assert.equal(await value(),'Synthetic edit during ordinary send');
   assert.equal(await page.$eval('.submit-button',node=>node.disabled),false,'Delivery releases sending even when user edits prevent draft consumption');
   // A confirmed clear may be followed by another continuation that fails.
   // Guard stale pre-send snapshots until clear, then permit host recovery again.
   await load(pending);
   await page.evaluate(text=>window.dispatchEvent(new MessageEvent('message',{data:{type:'sent',key:window.fixture.key,text}})),pending.draft);
   await update(pending);assert.equal(await value(),'','Late pre-delivery snapshot must not resurrect acknowledged input');
   await update(delivered);
   const nextFailure={...pending,draft:'Synthetic next unsent continuation',error:'Synthetic preparation refusal'};
   await update(nextFailure);assert.equal(await value(),nextFailure.draft,'A subsequent unsent continuation remains visible and recoverable');
   await edit('');await update(nextFailure);assert.equal(await value(),'','A deliberate user clear is also a local edit');
   const tabs=[{key:pending.key,name:'Synthetic task'},{key:'synthetic-other',name:'Synthetic other'}];
   await load({...pending,tabs});
   await update({...pending,key:'synthetic-other',draft:'',tabs});
   await page.evaluate(({key,text})=>window.dispatchEvent(new MessageEvent('message',{data:{type:'sent',key,text}})),{key:pending.key,text:pending.draft});
   assert.equal(await page.evaluate(key=>window.saved.drafts[key],pending.key),'','Positive inactive-key sent clears the owning cache');
   await update({...delivered,tabs});assert.equal(await value(),'','Inactive confirmation survives tab activation');
   await update({...pending,key:'synthetic-other',draft:'',tabs});
   assert.equal(await page.evaluate(key=>Object.hasOwn(window.saved.composerDrafts,key),pending.key),false,'Inactive cleared metadata is pruned');
   await load({...pending,tabs});
   await update({...pending,key:'synthetic-other',draft:'',tabs:[tabs[1]]});
   assert.equal(await page.evaluate(key=>Object.hasOwn(window.saved.composerDrafts,key) || Object.hasOwn(window.saved.drafts,key),pending.key),false,'Closed host-owned cache and metadata are dropped together');
   await update({...delivered,tabs});assert.equal(await value(),'');
   // Runtime may protect a saved user draft equal to the MCP input. A fresh
   // webview cannot infer that ownership from text; the acknowledgement carries it.
   await load(pending);
   await page.evaluate(text=>window.dispatchEvent(new MessageEvent('message',{data:{type:'sent',key:window.fixture.key,text,consumeDraft:false}})),pending.draft);
   assert.equal(await value(),pending.draft,'Equal-text user draft is protected by the host acknowledgement');
   await load({...pending,busy:true},await page.evaluate(()=>window.saved));
   assert.equal(await value(),pending.draft,'Protected ownership survives webview recreation');
   const bounds=await page.evaluate(()=>{
    const drafts={},records={};
    for(let index=0;index<140;index++){const key='synthetic-'+index;drafts[key]='Synthetic cached input';records[key]={host:drafts[key],owned:true};}
    const cache=new WorkbenchComposerDrafts(records);cache.prune('synthetic-139',undefined,drafts);
    const count=Object.keys(cache.records).length;
    for(const record of Object.values(cache.records))record.host='x'.repeat(200000);
    cache.prune('synthetic-139',undefined,drafts);
    return {count,characters:Object.values(cache.records).reduce((sum,row)=>sum+row.host.length,0),active:!!cache.records['synthetic-139']};
   });
   assert(bounds.count<=64 && bounds.characters<=1000000 && bounds.active,'Composer ownership metadata has count and size bounds');
   assert.deepEqual(errors,[]);
  }finally{await page.close();}
 }
 console.log('PASS: MCP draft sync without sent: open/recreated/switched tabs, failure recovery and user ownership; RU/EN, light/dark, narrow/wide.');
};
if(require.main===module){
 const puppeteer=require('puppeteer-core');
 const executablePath=[process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file=>file&&fs.existsSync(file));
 (async()=>{const browser=await puppeteer.launch({executablePath,headless:true,pipe:true});try{await module.exports({browser});}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
}
