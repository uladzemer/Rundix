const assert=require('node:assert/strict'),path=require('node:path');
module.exports=async({page})=>{
 const oldViewport=page.viewport();
 await page.evaluate(()=>{window.mcpOldDraft=document.querySelector('.composer textarea').value;window.mcpOldStyle=document.documentElement.getAttribute('style');window.mcpOldLanguage=WorkbenchI18n.language;});
 try{
  for(const language of ['ru','en'])for(const theme of ['dark','light'])for(const width of [320,900]){
   await page.setViewport({width,height:850});
   await page.evaluate(({language,theme})=>{
    WorkbenchI18n.setLanguage(language);
    const palette=theme==='dark'?{'editor-background':'#181818',foreground:'#ddd','descriptionForeground':'#999','editorWidget-background':'#252526','widget-border':'#444','input-background':'#292929','input-foreground':'#ddd'}:{'editor-background':'#fff',foreground:'#333','descriptionForeground':'#616161','editorWidget-background':'#f3f3f3','widget-border':'#cecece','input-background':'#fff','input-foreground':'#333'};
    for(const [key,value]of Object.entries(palette))document.documentElement.style.setProperty('--vscode-'+key,value);
    window.fixture.mcpBridgeRunning=true;window.update();
   },{language,theme});
   assert.equal(await page.$eval('.session-mcp',button=>button.textContent),'MCP');
   assert.equal(await page.$eval('.session-mcp',button=>button.classList.contains('is-running')),true);
   const box=await page.$eval('.session-mcp',button=>{const r=button.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,width:r.width};});
   assert(box.left>=0 && box.right<=width && box.width>=50);
   await page.$eval('.composer textarea',input=>{input.value='Synthetic draft retained on MCP navigation';input.dispatchEvent(new Event('input',{bubbles:true}));});
   await page.click('.session-mcp');
   assert.deepEqual(await page.evaluate(()=>{const call=window.calls.filter(call=>call.action==='mcpPanel').at(-1);return [call.action,call.currentDraft];}),['mcpPanel','Synthetic draft retained on MCP navigation']);
   assert.equal(await page.$eval('.composer textarea',input=>input.value),'Synthetic draft retained on MCP navigation');
   await page.evaluate(()=>{window.fixture.mcpBridgeRunning=false;window.update();});
   assert.equal(await page.$eval('.session-mcp',button=>button.classList.contains('is-running')),false);
   await page.screenshot({path:path.join(__dirname,`../.verification/mcp-entry-${language}-${theme}-${width}.png`)});
  }
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'open',action:'commands'}})));
  await page.type('.command-search','/mcp');await page.click('.command-list .menu-row');
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.action==='mcpPanel').length>=9),true);
 }finally{
  await page.setViewport(oldViewport);
  await page.evaluate(()=>{document.documentElement.setAttribute('style',window.mcpOldStyle || '');WorkbenchI18n.setLanguage(window.mcpOldLanguage);delete window.fixture.mcpBridgeRunning;window.fixture.draft=window.mcpOldDraft;const input=document.querySelector('.composer textarea');input.value=window.mcpOldDraft;input.dispatchEvent(new Event('input',{bubbles:true}));window.update();});
 }
};
