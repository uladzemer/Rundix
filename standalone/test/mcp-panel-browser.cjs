const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),puppeteer=require('puppeteer-core');
const chrome=[process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(file=>file&&fs.existsSync(file));
if(!chrome)throw Error('Set CHROME_PATH.');
const artifacts=process.env.RUNDIX_BROWSER_ARTIFACT_DIR || path.join(__dirname,'../.verification');
fs.mkdirSync(artifacts,{recursive:true});
(async()=>{
 const browser=await puppeteer.launch({executablePath:chrome,headless:true,pipe:true});
 try {
  for(const language of ['ru','en'])for(const theme of ['dark','light'])for(const width of [320,900]) {
   const page=await browser.newPage(),errors=[];page.on('pageerror',()=>errors.push('Synthetic page error'));
   await page.setViewport({width,height:1000});
   await page.setContent('<!doctype html><html><body><main id="app"></main></body></html>');
   await page.addStyleTag({content:fs.readFileSync(path.join(__dirname,'../ui/mcp-panel.css'),'utf8')});
   await page.evaluate(({language,theme})=>{
    if(theme==='light')for(const [key,value]of Object.entries({'sideBar-background':'#f5f5f5',foreground:'#242424','descriptionForeground':'#616161','editorWidget-background':'#fff','widget-border':'#ccc','list-inactiveSelectionBackground':'#e8e8e8','list-hoverBackground':'#ddd','input-background':'#fff','input-foreground':'#242424','input-border':'#bbb'}))document.documentElement.style.setProperty('--vscode-'+key,value);
    window.calls=[];window.acquireVsCodeApi=()=>({getState:()=>({}),setState:state=>window.saved=state,postMessage:message=>window.calls.push(message)});
    window.fixture={language,bridgeRunning:true,connection:{id:'synthetic-pool',label:'Synthetic working pool',external:true},connected:true,tasks:[
     {taskId:'synthetic-active',title:'Synthetic task <img src=x onerror="window.injected=true">',state:'waiting_approval',chatId:'synthetic-chat',projectDirectory:'D:/synthetic-project',progress:'Synthetic progress',pendingRequests:[{id:'synthetic-approval'}],report:{result:'Synthetic result',changedFiles:['synthetic.js'],checks:[{command:'synthetic-test',exitCode:0}],remainingIssues:[]}},
     {taskId:'synthetic-done',title:'Synthetic completed task',state:'completed',chatId:'synthetic-done-chat',projectDirectory:'D:/synthetic-other',report:{result:'Synthetic success',changedFiles:[],checks:['Synthetic check'],remainingIssues:[]}},
    ]};window.update=()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpState',data:window.fixture}}));
   },{language,theme});
   for(const file of ['translations.js','i18n.js','controls.js','mcp-panel.js'])await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../ui',file),'utf8')});await page.evaluate(()=>window.update());
   assert.equal(await page.$$('img').then(rows=>rows.length),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.evaluate(()=>{window.fixture.tasks[0].unsentInputs=[{id:'synthetic-unsent',text:'Synthetic unsent <img src=x onerror="window.injected=true">'}];window.update();});
   await page.evaluate(()=>{
    window.fixture.tasks[0].lastSelection={model:'synthetic-model',displayName:'Synthetic <model>',effort:'medium',turnId:'synthetic-turn'};
    window.fixture.modelDefaults={model:null,effort:'medium'};
    window.fixture.preferredModel='synthetic-preferred';
    window.fixture.models={status:'ready',list:[{model:'synthetic-preferred',displayName:'Synthetic preferred',defaultEffort:'medium',efforts:['medium','high']},{model:'synthetic-other',displayName:'Synthetic other',defaultEffort:'low',efforts:['low']}]};window.update();
   });
   assert.equal(await page.$eval('.last-selection',node=>node.textContent),(language==='ru'?'Модель: ':'Model: ')+'Synthetic <model> · '+(language==='ru'?'Среднее':'Medium'));
   await page.screenshot({path:path.join(artifacts,`mcp-model-settings-${language}-${theme}-${width}.png`),fullPage:true});
   assert.equal(await page.$$('#mcp-model option').then(rows=>rows.length),4);
   assert.equal(await page.$eval('#mcp-effort',node=>node.value),'medium');
   await page.type('#clarification','Synthetic settings draft');
   await page.focus('#mcp-model');
   await page.select('#mcp-model',JSON.stringify('synthetic-other'));
   const change=await page.evaluate(()=>window.calls.at(-1));
   assert.equal(change.action,'setModelDefaults');assert.equal(change.model,'synthetic-other');assert.equal(change.effort,'auto');
   assert.equal(await page.$eval('#mcp-model',node=>node.disabled),true);assert.equal(await page.$eval('#mcp-effort',node=>node.disabled),true);
   await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpResult',ok:false,requestId:window.calls.at(-1).requestId,error:'settings_write_failed'}})));
   assert.equal(await page.$eval('#mcp-model',node=>node.value),'null');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'mcp-model','Failed save restores keyboard focus');
   assert.equal(await page.$eval('#clarification',node=>node.value),'Synthetic settings draft');
   assert.match(await page.$eval('.alert',node=>node.textContent),/settings_write_failed/);
   await page.select('#mcp-effort','high');
   assert.deepEqual(await page.evaluate(()=>{const m=window.calls.at(-1);return [m.action,m.model,m.effort];}),['setModelDefaults',null,'high']);
   await page.evaluate(()=>{
    window.fixture.modelDefaults={model:null,effort:'high'};window.update();
    window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpResult',ok:true,action:'setModelDefaults',requestId:window.calls.at(-1).requestId}}));
   });
   await page.select('#mcp-model','""');
   assert.deepEqual(await page.evaluate(()=>{const m=window.calls.at(-1);return [m.model,m.effort];}),['','high']);
   await page.evaluate(()=>{
    window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpResult',ok:false,requestId:window.calls.at(-1).requestId}}));
    window.fixture.modelDefaults={model:'synthetic-missing',effort:'ultra'};window.update();
   });
   assert.match(await page.$eval('#mcp-model',node=>node.selectedOptions[0].textContent),language==='ru'?/недоступна/:/unavailable/);
   assert.equal(await page.$eval('#mcp-effort',node=>node.value),'ultra');
   for(const status of ['idle','loading','unavailable']){
    await page.evaluate(status=>{window.fixture.models={status,list:[]};window.update();},status);
    assert.equal(await page.$eval('#mcp-model',node=>node.disabled),true);assert.equal(await page.$eval('#mcp-effort',node=>node.disabled),true);
    assert(await page.$eval('.models-hint',node=>node.textContent.length>0));
    // Without a loaded catalog the saved model is unknown, not unavailable.
    assert.equal(await page.$eval('#mcp-model',node=>node.selectedOptions[0].textContent),'synthetic-missing');
   }
   await page.evaluate(()=>{
    window.fixture.modelDefaults={model:null,effort:'auto'};
    window.fixture.models={status:'ready',list:[{model:'synthetic-first',displayName:'Synthetic first',efforts:['low']},{model:'synthetic-second',displayName:'Synthetic second',efforts:['high','low']}]};window.update();
   });
   assert.deepEqual(await page.$$eval('#mcp-effort option',nodes=>nodes.map(node=>node.value)),['auto','low','high'],'Automatic without the preferred model offers the catalog union');
   await page.screenshot({path:path.join(artifacts,`mcp-automatic-fallback-${language}-${theme}-${width}.png`),fullPage:true});
   await page.select('#mcp-effort','high');
   assert.deepEqual(await page.evaluate(()=>{const message=window.calls.at(-1);return [message.action,message.model,message.effort];}),['setModelDefaults',null,'high']);
   await page.evaluate(()=>{window.fixture.modelDefaults.effort='high';window.update();window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpResult',ok:true,action:'setModelDefaults',requestId:window.calls.at(-1).requestId}}));});
   await page.evaluate(()=>{window.fixture.modelDefaults={model:null,effort:'auto'};window.fixture.tasks[0].lastSelection.effort=null;window.update();});
   assert(!await page.$eval('.last-selection',node=>node.textContent.includes(' · ')));
   await page.$eval('#clarification',node=>{node.value='';node.dispatchEvent(new Event('input'));});
   await page.click('.unsent-inputs summary');
   assert.equal(await page.$eval('.unsent-inputs summary',node=>node.textContent),language==='ru'
    ?'Неотправленные сообщения: полный текст доступен через get_task':'Unsent inputs: recover full text with get_task');
   assert.equal(await page.$eval('.unsent-inputs pre',node=>node.textContent),'Synthetic unsent <img src=x onerror="window.injected=true">');
   assert.equal(await page.$$('img').then(rows=>rows.length),0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Recovery preview fits both panel widths');
   await page.type('#clarification','Synthetic retained draft');await page.focus('#clarification');await page.evaluate(()=>{document.getElementById('clarification').setSelectionRange(5,10);window.update();});
   assert.deepEqual(await page.$eval('#clarification',input=>[input.value,input.selectionStart,input.selectionEnd,document.activeElement===input]),['Synthetic retained draft',5,10,true]);
   await page.click('form button');assert.equal(await page.evaluate(()=>window.calls.at(-1).action),'continue');
   assert.match(await page.evaluate(()=>window.calls.at(-1).requestId),/^[a-f0-9]{32}$/);
   await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpResult',ok:false,requestId:window.calls.at(-1).requestId}})));
   assert.equal(await page.$eval('#clarification',input=>input.value),'Synthetic retained draft');
   await page.click('form button');await page.type('#clarification',' — new draft while sending');
   await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpResult',ok:true,action:'continue',taskId:'synthetic-active',requestId:window.calls.at(-1).requestId}})));
   assert.equal(await page.$eval('#clarification',input=>input.value),'Synthetic retained draft — new draft while sending');
   await page.click('form button');await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpResult',ok:true,action:'continue',taskId:'synthetic-active',requestId:window.calls.at(-1).requestId}})));
   assert.equal(await page.$eval('#clarification',input=>input.value),'');
   await page.click('[data-task-id="synthetic-done"]');assert.equal(await page.$eval('.task-detail h2',node=>node.textContent),'Synthetic completed task');
   await page.evaluate(()=>{window.fixture.bridgeRunning=false;window.update();});assert.equal(await page.$eval('form button',button=>button.disabled),true);
   await page.evaluate(()=>{window.fixture.bridgeRunning=true;window.update();});
   await page.evaluate(()=>[...document.querySelectorAll('.connection button')].find(button=>button.textContent===({ru:'Конфигурация Claude',en:'Claude configuration'})[window.fixture.language]).click());
   await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpResult',ok:true,action:'configuration',requestId:window.calls.at(-1).requestId,configuration:{mcpServers:{rundix:{command:'node',args:['D:/synthetic-extension/runtime/mcp-server.cjs','--bridge','D:/synthetic-storage/mcp/bridge.json']}}}}})));
   assert.equal(await page.$('.configuration-json').then(Boolean),true);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.click('.claude-configuration button');assert.equal(await page.evaluate(()=>window.calls.at(-1).action),'copyConfiguration');
   await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpResult',ok:true,action:'copyConfiguration',requestId:window.calls.at(-1).requestId,configuration:{mcpServers:{rundix:{command:'node',args:['D:/synthetic-extension/runtime/mcp-server.cjs','--bridge','D:/synthetic-storage/mcp/bridge.json']}}}}})));
   fs.mkdirSync(artifacts,{recursive:true});
   await page.screenshot({path:path.join(artifacts,`mcp-panel-${language}-${theme}-${width}.png`),fullPage:true});
   await page.evaluate(()=>{window.fixture.serviceMode=true;window.fixture.tasks=[];window.update();});
   assert.match(await page.$eval('.service-note',node=>node.textContent),language==='ru'?/фоновом сервисе/:/background service/);
   assert.equal(await page.$('.task-detail'),null);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.screenshot({path:path.join(artifacts,`mcp-service-${language}-${theme}-${width}.png`),fullPage:true});
   await page.evaluate(()=>{
    window.fixture.configurationAvailable=true;window.fixture.spaceId='synthetic-space-a';window.fixture.spaces=[{spaceId:'synthetic-space-a',label:'Synthetic A'},{spaceId:'synthetic-space-b',label:'Synthetic B'}];
    window.fixture.tasks=[{taskId:'synthetic-service-wait',title:'Synthetic service wait',state:'waiting_limit',chatId:'synthetic-service-thread',projectDirectory:'D:/synthetic-a',progress:'Synthetic quota wait',waitingLimit:{resetAt:1800000300000,reason:'exhausted'},unsentInputCount:3}];window.update();
   });
   assert.equal(await page.$$('#space option').then(rows=>rows.length),2);
   assert.match(await page.$eval('.limit-reset',node=>node.textContent),language==='ru'?/Сброс лимитов/:/Reset at/);
   assert.match(await page.$eval('.unsent-count',node=>node.textContent),/3/);
   await page.screenshot({path:path.join(artifacts,`mcp-service-wait-${language}-${theme}-${width}.png`),fullPage:true});
   await page.type('#clarification','Synthetic service draft');await page.click('form button');
   const serviceSend=await page.evaluate(()=>window.calls.at(-1));assert.equal(serviceSend.spaceId,'synthetic-space-a');
   await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpResult',ok:false,requestId:window.calls.at(-1).requestId}})));
   assert.equal(await page.$eval('#clarification',node=>node.value),'Synthetic service draft');
   await page.click('form button');assert.equal(await page.evaluate(()=>window.calls.at(-1).requestId),serviceSend.requestId,'Failed service mutation keeps its idempotency key');
   await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpResult',ok:true,action:'continue',taskId:'synthetic-service-wait',requestId:window.calls.at(-1).requestId}})));
   await page.evaluate(()=>{window.fixture.tasks[0].state='error';window.fixture.tasks[0].waitingLimit=null;window.fixture.tasks[0].actionRequired='AUTH_REQUIRED';window.update();});
   assert.match(await page.$eval('.notice',node=>node.textContent),/AUTH_REQUIRED/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.screenshot({path:path.join(artifacts,`mcp-service-tasks-${language}-${theme}-${width}.png`),fullPage:true});
   await page.evaluate(()=>{window.fixture.taskChatsAvailable=true;window.fixture.tasks[0].readOnly=true;window.update();});
   await page.type('#clarification','Synthetic legacy draft');
   assert.equal(await page.$eval('form button',node=>node.disabled),true,'Legacy history cannot continue');
   assert.deepEqual(await page.$$eval('.task-detail .actions button',nodes=>nodes.map(node=>node.disabled)),[false,true,true],'Only transcript is available for imported history');
   assert.match(await page.$$eval('.notice',nodes=>nodes.map(node=>node.textContent).join(' ')),language==='ru'?/только чтение/:/read only/);
   await page.click('.task-detail .actions button');assert.equal(await page.evaluate(()=>window.calls.at(-1).action),'openChat');
   await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpResult',ok:true,action:'openChat',requestId:window.calls.at(-1).requestId}})));
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.screenshot({path:path.join(artifacts,`mcp-legacy-${language}-${theme}-${width}.png`),fullPage:true});
   const statusTexts=[];
   for(const legacyState of ['busy','retry_later','needs_repair']){
    await page.evaluate(legacyState=>{window.fixture.legacyStatus={state:legacyState};window.update();},legacyState);
    assert.match(await page.$eval('.legacy-status',node=>node.textContent),language==='ru'?/Импорт старой истории/:/Legacy history import/);
    const statusText=await page.$eval('.legacy-status',node=>node.textContent);statusTexts.push(statusText);
    assert.match(statusText,({busy:language==='ru'?/старое окно занято/:/owner busy/,retry_later:language==='ru'?/временная ошибка/:/temporary failure/,needs_repair:language==='ru'?/требуют восстановления/:/needs repair/})[legacyState]);
    assert.equal(await page.evaluate(()=>document.body.textContent.includes('service_unavailable')),false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(artifacts,`mcp-legacy-${legacyState}-${language}-${theme}-${width}.png`),fullPage:true});
   }
   assert.equal(new Set(statusTexts).size,3,'Each legacy status explains its own recovery state');
   await page.evaluate(()=>{window.fixture.tasks=[];window.fixture.modelDefaults={model:null,effort:'auto'};window.fixture.models={status:'ready',list:[{model:'gpt-6.2-sol',displayName:'Synthetic preferred',efforts:['medium']}]};window.update();});
   await page.focus('#mcp-effort');await page.evaluate(()=>window.update());
   assert.equal(await page.evaluate(()=>document.activeElement.id),'mcp-effort','Empty panel retains select focus');
   await page.select('#mcp-effort','medium');
   await page.evaluate(()=>{window.fixture.modelDefaults.effort='medium';window.update();window.dispatchEvent(new MessageEvent('message',{data:{type:'mcpResult',ok:true,action:'setModelDefaults',requestId:window.calls.at(-1).requestId}}));});
   assert.equal(await page.evaluate(()=>document.activeElement.id),'mcp-effort','Successful save restores keyboard focus');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('MCP panel browser: RU/EN, dark/light, narrow/wide, safe text, draft/focus retention and action results passed.');
 }finally{await browser.close();}
})().catch(error=>{console.error('MCP panel browser checks failed:',error.message);process.exitCode=1;});
