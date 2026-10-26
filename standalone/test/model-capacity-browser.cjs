// Synthetic capacity alert; no live connection or user session.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
module.exports=async({browser})=>{
  const page=await browser.newPage();
  try {
    await page.setContent('<html><body><main id="app"></main></body></html>');
    await page.addStyleTag({content:fs.readFileSync(path.join(__dirname,'../ui/app.css'),'utf8')});
    await page.evaluate(()=>{
      window.calls=[];window.fixture={key:'synthetic-capacity',id:'synthetic-thread',name:'Synthetic capacity recovery',
        account:{type:'chatgpt'},models:[],prefs:{access:'workspace'},items:[],tabs:[],requests:[],attachments:[],limits:{buckets:[]},
        error:'Selected model is at capacity. Please try a different model.',capacityRetry:{attempt:2,delaySeconds:120},draft:'Synthetic preserved draft'};
      window.acquireVsCodeApi=()=>({getState:()=>({}),setState(){},postMessage:message=>window.calls.push(message)});
      window.update=()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',data:window.fixture}}));
    });
    for(const file of ['translations','i18n','forms','questions','question-panel','icons','tabs','controls','toggles','modes','speed','changes','limits','limits-view','task-preflight','markdown','markdown-view','messages','activity','transcript-scroll','queued-editor','composer-drafts','app'])
      await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../ui',file+'.js'),'utf8')});
    const directory=path.join(__dirname,'../.verification');fs.mkdirSync(directory,{recursive:true});
    for(const language of ['ru','en'])for(const dark of [false,true])for(const width of [340,900]) {
      await page.setViewport({width,height:800});
      await page.evaluate(({language,dark})=>{
        document.body.classList.toggle('vscode-dark',dark);
        document.documentElement.style.colorScheme=dark?'dark':'light';
        for(const [key,value] of Object.entries({'editor-background':dark?'#181818':'#ffffff','editorWidget-background':dark?'#242424':'#fff0f0','foreground':dark?'#cccccc':'#242424','errorForeground':dark?'#f48771':'#a1260d','widget-border':dark?'#555555':'#bbbbbb','input-background':dark?'#242424':'#f5f5f5','inputValidation-errorBorder':'#c66'}))document.documentElement.style.setProperty('--vscode-'+key,value);
        WorkbenchI18n.setLanguage(language);window.fixture.language=language;window.update();
      },{language,dark});
      await page.waitForFunction(()=>document.querySelector('.error p'));
      assert.ok(await page.$eval('.error p',node=>node.textContent.includes('120') && node.textContent.includes('2/3')));
      assert.equal(await page.$eval('.error button',node=>node.textContent),language==='ru'?'Отменить автопродолжение':'Cancel auto-continue');
      assert.equal(await page.$eval('textarea',node=>node.value),'Synthetic preserved draft');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:path.join(directory,`capacity-${language}-${dark?'dark':'light'}-${width}.png`)});
      await page.evaluate(()=>{window.fixture.error=null;window.fixture.capacityRetry=null;window.fixture.busy=true;window.fixture.retrying=true;window.fixture.turnId='synthetic-retrying-turn';window.update();});
      assert.equal(await page.$('.error'),null,'CLI retries must not offer reconnect');
      assert.equal(await page.$eval('.activity-status',node=>node.hidden),false);
      assert.equal(await page.$eval('.activity-status',node=>node.dataset.phase),'retrying');
      assert.equal(await page.$eval('.activity-label',node=>node.textContent),language==='ru'?'Codex повторяет запрос…':'Codex is retrying…');
      assert.equal(await page.$eval('textarea',node=>node.value),'Synthetic preserved draft');
      await page.screenshot({path:path.join(directory,`cli-retrying-${language}-${dark?'dark':'light'}-${width}.png`)});
      await page.evaluate(()=>{window.fixture.error='Synthetic usage limit';window.fixture.limitRetry={attempt:1,max:2,delaySeconds:5};window.fixture.busy=false;window.fixture.retrying=false;window.fixture.turnId=null;window.update();});
      assert.ok(await page.$eval('.error p',node=>node.textContent.includes('5') && node.textContent.includes('1/2')));
      assert.equal(await page.$eval('.error button',node=>node.textContent),language==='ru'?'Отменить автопродолжение':'Cancel auto-continue');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:path.join(directory,`usage-limit-${language}-${dark?'dark':'light'}-${width}.png`)});
      await page.evaluate(()=>{window.fixture.limitRetry=null;window.fixture.error='Selected model is at capacity. Please try a different model.';window.fixture.capacityRetry={attempt:2,delaySeconds:120};window.update();});
    }
    await page.click('.error button');
    assert.equal(await page.evaluate(()=>window.calls.at(-1).action),'stop');
    await page.evaluate(()=>{window.fixture.capacityRetry=null;window.update();});
    assert.equal(await page.$('.error p'),null);
    assert.equal(await page.$eval('.error button',node=>node.textContent),'Reconnect');
    console.log('PASS: capacity retry alert, cancel action, preserved draft; RU/EN, light/dark, narrow/wide.');
  } finally {await page.close();}
};
