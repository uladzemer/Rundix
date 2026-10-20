const assert=require('node:assert/strict');
const path=require('node:path');

module.exports=async({page,suffix=''})=>{
  const viewport=page.viewport();
  const theme=await page.$eval('html',n=>n.getAttribute('style'));
  const original=await page.evaluate(()=>({fixture:window.fixture,draft:document.querySelector('textarea').value}));
  try{
    await page.evaluate(light=>{
      for(const [key,value] of Object.entries({'editor-background':light?'#fff':'#1e1e1e',foreground:light?'#333':'#ccc',
        'editorWidget-background':light?'#f3f3f3':'#242424','input-background':light?'#fff':'#242424',
        'input-foreground':light?'#333':'#ccc',descriptionForeground:light?'#616161':'#999','widget-border':light?'#cecece':'#383838'}))
        document.documentElement.style.setProperty('--vscode-'+key,value);
    },suffix.includes('light'));
    for(const width of [340,1000]){
      await page.setViewport({width,height:850});
      await page.evaluate(width=>{
        window.fixture={...window.fixture,key:'synthetic-mcp-'+width,id:'synthetic-mcp-thread',draft:'Synthetic MCP task',
          items:[{id:'synthetic-mcp-input',type:'userMessage',text:'Synthetic MCP task'},
            {id:'synthetic-mcp-progress',type:'agentMessage',text:'Synthetic task is running.'}],
          busy:true,error:null,requests:[],attachments:[],followUps:[],followUpSending:false};
        window.update();
      },width);
      assert.equal(await page.$eval('textarea',n=>n.value),'Synthetic MCP task');
      await page.evaluate(()=>{
        window.fixture.draft='';window.update();
        window.dispatchEvent(new MessageEvent('message',{data:{type:'sent',key:window.fixture.key,text:'Synthetic MCP task'}}));
      });
      assert.equal(await page.$eval('textarea',n=>n.value),'','MCP acknowledgement clears the hydrated task without a local pending send');
      assert.ok(await page.$('[data-item-id="synthetic-mcp-input"]'));
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:path.join(__dirname,'../.verification/mcp-composer-'+width+suffix+'.png')});
      await page.$eval('textarea',n=>{n.value='Synthetic newer draft';n.dispatchEvent(new Event('input',{bubbles:true}));});
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'sent',key:window.fixture.key,text:'Synthetic MCP task'}})));
      assert.equal(await page.$eval('textarea',n=>n.value),'Synthetic newer draft','Delayed acknowledgement preserves new input');
      await page.evaluate(()=>{
        window.fixture={...window.fixture,key:'synthetic-other-'+window.fixture.key,draft:'Synthetic other draft'};window.update();
        window.dispatchEvent(new MessageEvent('message',{data:{type:'sent',key:'synthetic-mcp-'+innerWidth,text:'Synthetic MCP task'}}));
      });
      assert.equal(await page.$eval('textarea',n=>n.value),'Synthetic other draft','Acknowledgement for another session preserves the active input');
      if(!suffix)assert.equal(await page.evaluate(()=>window.saved.drafts['synthetic-mcp-'+innerWidth]),'Synthetic newer draft','Inactive user edits survive delayed acknowledgement and recreation');
      await page.evaluate(()=>{window.fixture={...window.fixture,key:'synthetic-mcp-'+innerWidth};window.update();});
      assert.equal(await page.$eval('textarea',n=>n.value),'Synthetic newer draft','Returning to the task preserves its unrelated local draft');
    }
  }finally{
    await page.evaluate(original=>{window.fixture=original.fixture;window.update();const input=document.querySelector('textarea');input.value=original.draft;input.dispatchEvent(new Event('input',{bubbles:true}));},original);
    await page.setViewport(viewport);
    await page.$eval('html',(n,style)=>{if(style===null)n.removeAttribute('style');else n.setAttribute('style',style);},theme);
  }
};
