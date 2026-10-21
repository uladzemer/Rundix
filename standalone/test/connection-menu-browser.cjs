const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const puppeteer=require('puppeteer-core');
const chrome=process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
(async()=>{
  fs.mkdirSync(path.join(__dirname,'../.verification'),{recursive:true});
  const browser=await puppeteer.launch({executablePath:chrome,headless:true,pipe:true});
  try {
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<html><body><main id="app"></main></body></html>');
    await page.addStyleTag({content:fs.readFileSync(path.join(__dirname,'../ui/app.css'),'utf8')});
    await page.evaluate(()=>{
      window.calls=[];
      window.fixture={key:'synthetic',id:null,name:'Synthetic menu',account:{type:'chatgpt'},models:[],prefs:{access:'workspace'},items:[],tabs:[],requests:[],limits:{buckets:[]},
        connection:{id:'synthetic',label:'Synthetic connection',external:true,configurable:true}};
      window.acquireVsCodeApi=()=>({getState:()=>({}),setState(){},postMessage:message=>window.calls.push(message)});
      window.update=()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',data:window.fixture}}));
    });
    for(const file of ['translations','i18n','forms','questions','question-panel','icons','tabs','controls','toggles','modes','speed','changes','limits','limits-view','task-preflight','markdown','markdown-view','messages','activity','transcript-scroll','queued-editor','composer-drafts','app'])
      await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../ui',file+'.js'),'utf8')});
    await page.evaluate(()=>{window.update();window.dispatchEvent(new MessageEvent('message',{data:{type:'open',action:'account'}}));});
    for(const language of ['ru','en']) for(const dark of [false,true]) for(const width of [340,900]) {
      await page.setViewport({width,height:900});
      await page.evaluate(({language,dark})=>{
        document.documentElement.classList.toggle('vscode-dark',dark);document.body.classList.toggle('vscode-dark',dark);
        for(const [key,value] of Object.entries({'editor-background':dark?'#181818':'#ffffff','sideBar-background':dark?'#181818':'#ffffff','input-background':dark?'#242424':'#f5f5f5','editorWidget-background':dark?'#242424':'#f5f5f5','foreground':dark?'#cccccc':'#242424','descriptionForeground':dark?'#a0a0a0':'#666666','widget-border':dark?'#383838':'#dddddd'}))document.documentElement.style.setProperty('--vscode-'+key,value);
        WorkbenchI18n.setLanguage(language);
        window.fixture.language=language;
        window.fixture.connection.menu={title:'Synthetic choices '+language+' '+dark,revision:'synthetic-revision',items:[{id:'one',label:'one@example.test',detail:'plus',checked:true},{id:'two',label:'two@example.test',detail:'pro'}]};window.update();
      },{language,dark});
      await page.waitForFunction(()=>document.querySelector('.account-menu')?.textContent.includes('two@example.test'));
      await page.screenshot({path:path.join(__dirname,`../.verification/connection-menu-${language}-${dark?'dark':'light'}-${width}.png`)});
      const bounds=await page.$eval('.account-menu',node=>({scroll:node.scrollWidth,client:node.clientWidth}));
      assert.ok(bounds.scroll<=bounds.client+1,JSON.stringify({language,dark,width,...bounds}));
    }
    await page.$$eval('.account-menu button',buttons=>buttons.find(button=>button.textContent.includes('two@example.test')).click());
    assert.ok(await page.evaluate(()=>window.calls.some(call=>call.action==='connectionMenuAction' && call.id==='two' && call.revision==='synthetic-revision')));
    await page.evaluate(()=>{window.fixture.busy=true;window.update();});
    assert.equal(await page.$$eval('.account-menu button',buttons=>buttons.filter(button=>button.textContent.includes('@example.test')).every(button=>button.disabled)),true);
    await page.evaluate(()=>{window.fixture.busy=false;window.fixture.connection.menu=null;window.update();});
    assert.equal(await page.$eval('.account-menu',node=>node.textContent.includes('@example.test')),false);
    await page.evaluate(()=>{window.fixture.connection.menu={error:true};window.update();});
    assert.equal(await page.$eval('.account-menu',node=>node.textContent.includes('Could not refresh')),true);
    assert.deepEqual(errors,[]);
    console.log('PASS: generic connection choices, action scope, hidden/error state, busy guard, RU/EN and narrow/wide themes.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
