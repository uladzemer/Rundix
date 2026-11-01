// Synthetic toolbar fixtures. Runs inside the existing main-chat browser suite.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
module.exports=async({browser})=>{
  const page=await browser.newPage();
  try {
    for(const language of ['ru','en'])for(const theme of ['light','dark'])for(const width of [320,900]) {
      await page.setViewport({width,height:300});
      await page.setContent('<html><body><main id="fixture"></main></body></html>');
      await page.addStyleTag({content:fs.readFileSync(path.join(__dirname,'../ui/app.css'),'utf8')});
      for(const file of ['translations.js','i18n.js','tabs.js'])await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../ui',file),'utf8')});
      await page.evaluate(({language,theme})=>{
        WorkbenchI18n.setLanguage(language);
        document.documentElement.style.setProperty('--vscode-editor-background',theme==='dark'?'#181818':'#ffffff');
        document.documentElement.style.setProperty('--vscode-foreground',theme==='dark'?'#dddddd':'#222222');
        document.documentElement.style.setProperty('--vscode-descriptionForeground',theme==='dark'?'#aaaaaa':'#616161');
        window.actions=[];
        window.tabs=new WorkbenchTabs({icon:()=>document.createElement('span'),send:action=>actions.push(action),closeMenus(){}});
        document.querySelector('#fixture').append(tabs.element);
        window.synthetic={key:'synthetic',name:'Synthetic chat',worktree:{branch:'rundix/synthetic-long-chat-name-0123456789ab'}};
        tabs.update(synthetic);
      },{language,theme});
      assert.equal(await page.$eval('.mergeWorktree',n=>n.textContent),language==='ru'?'Влить':'Merge');
      assert.equal(await page.$eval('.removeWorktree',n=>n.textContent),language==='ru'?'Удалить worktree':'Remove worktree');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.ok(await page.$eval('.worktree-branch',n=>n.getBoundingClientRect().width>30));
      await page.click('.mergeWorktree');await page.click('.removeWorktree');
      assert.deepEqual(await page.evaluate(()=>actions),['mergeWorktree','removeWorktree']);
      for(const field of ['busy','compacting','worktreeBusy']) {
        await page.evaluate(field=>{synthetic[field]=true;tabs.update(synthetic);},field);
        assert.equal(await page.$eval('.mergeWorktree',n=>n.disabled),true);
        assert.equal(await page.$eval('.removeWorktree',n=>n.disabled),true);
        await page.evaluate(field=>{synthetic[field]=false;tabs.update(synthetic);},field);
      }
      // Keep generated screenshots outside the repository for optional visual inspection.
      await page.screenshot({path:path.join(require('node:os').tmpdir(),`rundix-synthetic-worktree-${language}-${theme}-${width}.png`)});
      await page.evaluate(()=>{synthetic.worktree=null;tabs.update(synthetic);});
      assert.equal(await page.$eval('.session-worktree',n=>n.hidden),true);
    }
    console.log('PASS worktree toolbar: RU/EN, light/dark, narrow/wide, actions and busy states.');
  }finally{await page.close();}
};
