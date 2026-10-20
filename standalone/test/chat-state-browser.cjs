const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
module.exports=async({browser})=>{
 const scripts=[...fs.readFileSync(path.join(__dirname,'../extension.cjs'),'utf8').matchAll(/uri\("([^"/]+\.js)"\)/g)].map(match=>match[1]);
 assert.ok(scripts.includes('app.js'));
 for(const language of ['ru','en'])for(const light of [false,true]){
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewport({width:light?360:800,height:850});
  const fixture={key:'synthetic-session',hostKey:'synthetic-host',name:'Synthetic chat',historyScope:'all',language,
   models:[],prefs:{},items:[],requests:[{id:'synthetic-quiz',method:'item/tool/requestUserInput',params:{questions:[{id:'answer',question:'Synthetic question',options:[{label:'Alpha'},{label:'Beta'}]}]}}],
   followUps:[{id:'synthetic-queue',text:'Synthetic original',editable:true,attachments:[]} ]};
  const load=async(saved={})=>{
   await page.goto('about:blank');await page.setContent(`<html data-language="${language}"><body><main id="app"></main></body></html>`);
   await page.addStyleTag({content:fs.readFileSync(path.join(__dirname,'../ui/app.css'),'utf8')});
   await page.evaluate(({fixture,saved,light})=>{
    window.fixture=fixture;window.saved=saved;window.calls=[];
    document.documentElement.style.setProperty('--vscode-editor-background',light?'#ffffff':'#1e1e1e');
    document.documentElement.style.setProperty('--vscode-foreground',light?'#333333':'#cccccc');
    window.update=()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',data:window.fixture}}));
    window.acquireVsCodeApi=()=>({getState:()=>window.saved,setState:state=>window.saved=state,postMessage:message=>{window.calls.push(message);if(message.action==='ready')queueMicrotask(window.update);}});
   },{fixture,saved,light});
   for(const script of scripts)await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../ui',script),'utf8')});
   await page.evaluate(()=>window.update());
  };
  await load();
  await page.click('.quiz-multiple');await page.click('.quiz-option');
  await page.$eval('.quiz-custom-answer',node=>node.open=true);
  await page.type('.quiz-form input','Synthetic custom');
  await page.click('.question-panel-toggle');await page.click('.queued-message-text');
  await page.$eval('.queued-editor textarea',node=>{node.value='Synthetic unsaved edit';node.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.screenshot({path:path.join(__dirname,`../.verification/chat-state-${language}-${light?'light':'dark'}.png`)});
  const saved=await page.evaluate(()=>window.saved);
  // Identical request/item IDs in another session must not borrow drafts.
  await page.evaluate(()=>{const original=window.fixture;window.fixture={...original,key:'synthetic-other'};window.update();});
  assert.equal(await page.$eval('.quiz-form input',node=>node.value),'');
  await page.evaluate(()=>{window.fixture.key='synthetic-session';window.update();});
  await load(saved);
  assert.equal(await page.$eval('.quiz-form input',node=>node.value),'Synthetic custom');
  assert.equal(await page.$eval('.quiz-option',node=>node.getAttribute('aria-checked')),'true');
  await page.click('.question-panel-toggle');await page.click('.queued-message-text');
  assert.equal(await page.$eval('.queued-editor textarea',node=>node.value),'Synthetic unsaved edit');
  // A failed save keeps the draft, while a confirmed save removes it.
  await page.click('.queued-editor .primary-button');
  await page.evaluate(()=>{const call=window.calls.findLast(call=>call.action==='editQueued');window.dispatchEvent(new MessageEvent('message',{data:{type:'queuedEditResult',key:window.fixture.key,requestId:call.requestId,ok:false}}));});
  assert.equal(await page.evaluate(()=>window.saved.queuedDrafts.length),1);
  await page.click('.queued-editor .primary-button');
  await page.evaluate(()=>{const call=window.calls.findLast(call=>call.action==='editQueued');window.dispatchEvent(new MessageEvent('message',{data:{type:'queuedEditResult',key:window.fixture.key,requestId:call.requestId,ok:true}}));});
  assert.equal(await page.evaluate(()=>window.saved.queuedDrafts.length),0);
  await page.waitForFunction(()=>!document.querySelector('.queued-editor').open && document.activeElement===document.querySelector('.composer textarea'));
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'open',action:'history'}})));
  assert.equal(await page.evaluate(()=>window.calls.findLast(call=>call.action==='history').scope),'all');
  const respond=()=>page.evaluate(()=>{const call=window.calls.findLast(call=>call.action==='history');window.dispatchEvent(new MessageEvent('message',{data:{type:'history',generation:call.generation,data:[{id:'synthetic-history',name:'Synthetic history'}],cursor:'synthetic-next'}}));});
  await respond();
  assert.equal(await page.$eval('.menu input',node=>node===document.activeElement),true);
  await page.type('.menu input','Synthetic');
  await page.waitForFunction(()=>window.calls.findLast(call=>call.action==='history')?.query==='Synthetic');
  await respond();
  assert.deepEqual(await page.$eval('.menu input',node=>({focused:node===document.activeElement,start:node.selectionStart,value:node.value})),{focused:true,start:9,value:'Synthetic'});
  for(const selector of ['.menu select','.menu-row','.menu > div:last-child > button:last-child']){
   await page.focus(selector);const handle=await page.evaluateHandle(()=>document.activeElement);
   await respond();assert.equal(await page.evaluate(node=>node===document.activeElement,handle),true,'History response retains focused control');await handle.dispose();
  }
  await page.evaluate(()=>{
   const generation=window.calls.findLast(call=>call.action==='history').generation;
   const send=data=>window.dispatchEvent(new MessageEvent('message',{data:{type:'history',generation,data}}));
   send([{id:'synthetic-a',name:'Synthetic A'},{id:'synthetic-b',name:'Synthetic B'}]);
   window.focusedHistory=document.querySelectorAll('.menu-row')[1];window.focusedHistory.focus();
   send([{id:'synthetic-b',name:'Synthetic B'},{id:'synthetic-a',name:'Synthetic A'}]);
  });
  assert.equal(await page.evaluate(()=>document.activeElement===window.focusedHistory),true,'Reordered results retain row focus');
  await page.keyboard.press('Escape');
  await page.click('.question-panel-toggle');
  await page.click('.quiz-form button[type=submit]');
  assert.equal(await page.evaluate(()=>window.saved.quizDrafts.length),0);
  await page.evaluate(()=>{window.fixture.requests=[];window.fixture.followUps=[];window.update();});
  assert.equal(await page.evaluate(()=>window.saved.quizDrafts.length),0);
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('PASS: synthetic RU/EN light/dark narrow/wide draft recreation, history default scope and focus retention.');
};
