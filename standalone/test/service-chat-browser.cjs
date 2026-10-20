require('./test-isolation.cjs').isolate();
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),puppeteer=require('puppeteer-core');
const chrome=[process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(file=>file&&fs.existsSync(file));
if(!chrome)throw Error('Set CHROME_PATH.');
const artifacts=process.env.RUNDIX_BROWSER_ARTIFACT_DIR || path.join(__dirname,'../.verification');
fs.mkdirSync(artifacts,{recursive:true});
(async()=>{
  const browser=await puppeteer.launch({executablePath:chrome,headless:true,pipe:true});
  try{
    for(const language of ['ru','en'])for(const theme of ['light','dark'])for(const width of [320,900]){
      const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.setViewport({width,height:1000});
      await page.setContent('<!doctype html><html><body><main id="app"></main></body></html>');
      for(const file of ['mcp-panel.css','service-chat.css'])await page.addStyleTag({content:fs.readFileSync(path.join(__dirname,'../ui',file),'utf8')});
      await page.evaluate(({language,theme})=>{
        if(theme==='light')for(const [key,value]of Object.entries({'sideBar-background':'#f5f5f5',foreground:'#242424','descriptionForeground':'#616161','editorWidget-background':'#fff','widget-border':'#ccc','input-background':'#fff','input-foreground':'#242424','input-border':'#bbb'}))document.documentElement.style.setProperty('--vscode-'+key,value);
        window.calls=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:state=>window.saved=state,postMessage:message=>window.calls.push(message)});
        window.fixture={language,spaceId:'synthetic-a',taskId:'synthetic-task',generation:'synthetic-generation',viewRevision:1,chatId:'synthetic-thread',title:'MCP · Synthetic chat',owner:'service',state:'waiting_approval',progress:'Synthetic progress',
          draftState:{draft:'Synthetic restored host draft'},items:[{id:'synthetic-user',type:'userMessage',text:'Synthetic user'},{id:'synthetic-agent',type:'agentMessage',text:'Synthetic **answer** <img src=x onerror="window.injected=true">\n\n```js\nconst synthetic = 1;\n```'}],
          pendingRequests:[{id:'synthetic-question',method:'item/tool/requestUserInput',params:{questions:[{id:'synthetic-choice',question:'Synthetic choice?',options:[{label:'Synthetic option',description:'Synthetic detail'}]}]}}]};
        window.update=()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'serviceChat',data:window.fixture}}));
        window.ack=ok=>{const last=window.calls.findLast(message=>message.requestId);window.dispatchEvent(new MessageEvent('message',{data:{type:'chatResult',ok,action:last.action,requestId:last.requestId}}));};
      },{language,theme});
      for(const file of ['translations.js','i18n.js','forms.js','questions.js','markdown.js','markdown-view.js','task-report.js','service-chat.js'])await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../ui',file),'utf8')});
      await page.evaluate(()=>window.update());assert.deepEqual(errors,[]);
      const rawReport=JSON.stringify({result:'Synthetic **readable** report\n\n```js\nconst reportSynthetic = 2;\n```',changedFiles:['synthetic-'+ 'x'.repeat(120)+'.txt'],checks:['Synthetic passed'],remainingIssues:['Synthetic follow-up <img src=x onerror="window.injected=true">']});
      await page.evaluate(raw=>{
        window.fixture.items.push({id:'synthetic-report',type:'agentMessage',text:raw},{id:'synthetic-user-json',type:'userMessage',text:raw},
          {id:'synthetic-partial',type:'agentMessage',text:'{"result":"Synthetic partial'});
        window.fixture.viewRevision++;window.update();
      },rawReport);
      assert.equal(await page.$eval('[data-item-id="synthetic-report"] .message-content strong',node=>node.textContent),'readable');
      assert.deepEqual(await page.$$eval('[data-item-id="synthetic-report"] .message-content p > strong',nodes=>nodes.filter(n=>n.parentElement.textContent===n.textContent).map(n=>n.textContent)),
        language==='ru'?['Изменённые файлы','Проверки','Что осталось']:['Changed files','Checks','Remaining issues']);
      assert.equal(await page.$$eval('[data-item-id="synthetic-report"] li',nodes=>nodes.length),3);
      assert(!(await page.$eval('[data-item-id="synthetic-report"]',node=>node.textContent)).includes('"changedFiles"'));
      assert((await page.$eval('[data-item-id="synthetic-user-json"]',node=>node.textContent)).includes('"changedFiles"'),'User JSON remains literal');
      assert((await page.$eval('[data-item-id="synthetic-partial"]',node=>node.textContent)).includes('{"result"'),'Partial report remains literal');
      assert.equal(await page.evaluate(()=>window.fixture.items.find(i=>i.id==='synthetic-report').text),rawReport,'Display formatting does not rewrite the transcript');
      await page.click('[data-item-id="synthetic-report"] .code-copy');
      assert.match(await page.evaluate(()=>window.calls.at(-1).text),/reportSynthetic/,'Copy uses displayed Markdown code blocks');
      await page.evaluate(()=>{window.fixture.language=window.fixture.language==='ru'?'en':'ru';window.fixture.viewRevision++;window.update();});
      assert((await page.$eval('[data-item-id="synthetic-report"]',node=>node.textContent)).includes(language==='ru'?'Changed files':'Изменённые файлы'));
      await page.evaluate(language=>{window.fixture.language=language;window.fixture.viewRevision++;window.update();},language);
      assert.equal(await page.$eval('#service-draft',node=>node.value),'Synthetic restored host draft');
      assert.equal(await page.$$('img').then(nodes=>nodes.length),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
      await page.$eval('#service-draft',node=>{node.value='';node.dispatchEvent(new Event('input'));});
      await page.type('#service-draft','Synthetic retained draft');await page.focus('#service-draft');
      await page.evaluate(()=>{document.getElementById('service-draft').setSelectionRange(3,8);window.fixture.viewRevision++;window.update();});
      assert.deepEqual(await page.$eval('#service-draft',node=>[node.value,node.selectionStart,node.selectionEnd,document.activeElement===node]),['Synthetic retained draft',3,8,true]);
      await page.click('.composer button');const first=await page.evaluate(()=>window.calls.findLast(message=>message.requestId));await page.evaluate(()=>window.ack(false));
      assert.equal(await page.$eval('#service-draft',node=>node.value),'Synthetic retained draft');await page.click('.composer button');
      assert.equal(await page.evaluate(()=>window.calls.findLast(message=>message.requestId).requestId),first.requestId);
      await page.$eval('#service-draft',node=>node.setSelectionRange(node.value.length,node.value.length));await page.type('#service-draft',' new');await page.evaluate(()=>window.ack(true));
      assert.equal(await page.$eval('#service-draft',node=>node.value),'Synthetic retained draft new','Successful send preserves new typing');
      await page.click('.quiz-option');await page.click('.quiz-form button[type=submit]');
      const answer=await page.evaluate(()=>window.calls.findLast(message=>message.requestId));assert.equal(answer.action,'answer');assert.equal(answer.approval.answers['synthetic-choice'],'Synthetic option');
      await page.evaluate(()=>{window.ack(false);window.fixture.viewRevision++;window.update();});
      assert.equal(await page.$eval('input[name="synthetic-choice"]',node=>node.value),'Synthetic option','Question draft survives failed answer and refresh');
      await page.click('.quiz-form button[type=submit]');assert.equal(await page.evaluate(()=>window.calls.findLast(message=>message.requestId).requestId),answer.requestId);await page.evaluate(()=>window.ack(true));
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'chatHistory',data:{items:[{id:'synthetic-old-code',type:'agentMessage',text:'```js\nconst oldSynthetic = 1;\n```'}],cursor:null}}})));
      await page.click('[data-item-id="synthetic-old-code"] .code-copy');assert.equal(await page.evaluate(()=>window.calls.at(-1).action),'copyText');assert.match(await page.evaluate(()=>window.calls.at(-1).text),/oldSynthetic/);
      await page.evaluate(()=>{
        window.dispatchEvent(new MessageEvent('message',{data:{type:'chatHistory',data:{items:[],cursor:'synthetic-next'}}}));
        window.fixture.cursor='@latest';window.fixture.viewRevision++;window.update();
        [...document.querySelectorAll('.actions button')].at(-1).click();
      });
      assert.equal(await page.evaluate(()=>window.calls.at(-1).cursor),'synthetic-next','Live snapshots preserve history traversal cursor');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:path.join(artifacts,`service-chat-${language}-${theme}-${width}.png`),fullPage:true});
      await page.evaluate(()=>{window.fixture.readOnly=true;window.fixture.owner='legacy';window.fixture.pendingRequests=[];window.fixture.viewRevision++;window.update();});
      assert.equal(await page.$eval('.composer button',node=>node.disabled),true,'Imported chats never send continuations');
      assert.equal(await page.$eval('.actions button:nth-child(2)',node=>node.disabled),true,'Imported chats never cancel a task');
      assert.match(await page.$eval('.service-note',node=>node.textContent),language==='ru'?/только чтение/:/read only/);
      assert.equal(await page.$eval('#service-draft',node=>node.value),'Synthetic retained draft new');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:path.join(artifacts,`service-chat-legacy-${language}-${theme}-${width}.png`),fullPage:true});
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'serviceChat',data:null}})));
      assert.equal(await page.$eval('#service-draft',node=>node.value),'Synthetic retained draft new');assert.equal(await page.$eval('.composer button',node=>node.disabled),true);
      await page.evaluate(()=>{window.fixture.closed=true;window.fixture.pendingRequests=[];window.update();});
      assert.equal(await page.evaluate(()=>window.calls.at(-1).action),'closeReady');assert.equal(await page.evaluate(()=>window.calls.at(-1).state.draft),'Synthetic retained draft new');
      assert.deepEqual(errors,[]);await page.close();
    }
    console.log('PASS service chat browser: RU/EN, themes/widths, safe Markdown, composer/question drafts, idempotent explicit retry and draft-aware close.');
  }finally{await browser.close();}
})().catch(error=>{console.error('Synthetic service chat browser failed:',error.message);process.exitCode=1;});
