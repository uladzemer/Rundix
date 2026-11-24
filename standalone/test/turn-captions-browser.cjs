// Synthetic turn IDs, items and catalog labels only. Shared by the two chat harnesses.
const assert=require('node:assert/strict'),path=require('node:path');
module.exports=async function({page,service=false,language,theme,width,artifacts}){
  await page.evaluate(service=>{
    window.captionOriginal=window.fixture;
    const text='Synthetic same user text';
    const item=(id,type,turnId)=>({id,type,turnId,text,content:[{type:'text',text}]});
    window.captionEarlier=[item('synthetic-caption-user-1','userMessage','synthetic-caption-turn-1'),
      {...item('synthetic-caption-agent-1','agentMessage','synthetic-caption-turn-1'),phase:'final_answer'}];
    window.fixture={...window.fixture,generation:'synthetic-caption-generation',busy:true,hasOlder:true,
      prefs:{...window.fixture.prefs,focus:true},
      turnSelections:[{turnId:'synthetic-caption-turn-1',model:'synthetic-first',displayName:'Synthetic <first>',effort:'medium'},
        {turnId:'synthetic-caption-turn-2',model:'synthetic-second',displayName:'Synthetic second',effort:'high'}],
      items:[item('synthetic-caption-user-2','userMessage','synthetic-caption-turn-2'),
        {...item('synthetic-caption-agent-2','agentMessage','synthetic-caption-turn-2'),phase:'commentary'},
        {...item('synthetic-caption-command','commandExecution','synthetic-caption-turn-2'),command:'synthetic-check',status:'completed'},
        item('synthetic-caption-steer','userMessage','synthetic-caption-turn-2'),
        item('synthetic-caption-unrecorded','userMessage','synthetic-caption-turn-unknown'),
        item('synthetic-caption-unlinked','userMessage',undefined)],cursor:'synthetic-caption-page'};
    window.update();
  },service);
  assert.equal(await page.$$('.turn-model-caption').then(rows=>rows.length),1,'A known selection without its user item has no guessed caption');
  if(service){
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'chatHistory',data:{items:window.captionEarlier,cursor:null}}})));
  }else await page.evaluate(()=>{window.fixture.items=[...window.captionEarlier,...window.fixture.items];window.update();});
  const expected=['Synthetic <first> · '+(language==='ru'?'Среднее':'Medium'),'Synthetic second · '+(language==='ru'?'Высокое':'High')];
  const shown=()=>page.$$eval('.turn-model-caption',nodes=>nodes.map(node=>[node.textContent,node.previousElementSibling?.dataset.itemId,node.dataset.turnId]));
  assert.deepEqual(await shown(),[
    [expected[0],'synthetic-caption-user-1','synthetic-caption-turn-1'],
    [expected[1],'synthetic-caption-user-2','synthetic-caption-turn-2'],
  ]);
  await page.evaluate(()=>{window.captionHistory=window.fixture.turnSelections;window.fixture.turnSelections=[];window.fixture.viewRevision++;window.update();});
  assert.equal(await page.$$('.turn-model-caption').then(rows=>rows.length),0);
  await page.evaluate(()=>{window.fixture.turnSelections=window.captionHistory;delete window.captionHistory;window.fixture.viewRevision++;window.update();});
  assert.deepEqual((await shown()).map(row=>row[0]),expected,'An ACK-only history update renders captions without changing items');
  await page.evaluate(()=>{window.captionNodes=[...document.querySelectorAll('.turn-model-caption')];window.fixture.items.find(item=>item.id==='synthetic-caption-agent-2').text+=' Synthetic streamed delta';window.fixture.viewRevision++;window.update();});
  assert.deepEqual((await shown()).map(row=>row[0]),expected);
  assert.equal(await page.evaluate(()=>window.captionNodes.every(node=>node.isConnected)),true,'Streaming keeps caption nodes');
  // An overlapping page/state must not duplicate an existing turn's caption.
  if(service){
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'chatHistory',data:{items:window.captionEarlier,cursor:null}}})));
  }else{
    assert.equal(await page.$$('.focus-group').then(nodes=>nodes.length),1);
    await page.$eval('.focus-group',node=>{node.open=true;});await page.evaluate(()=>window.update());
    assert.equal(await page.$eval('.focus-group',node=>node.open),true,'Streaming preserves the expanded focus group and its captions');
    await page.evaluate(()=>{window.fixture.prefs.focus=false;window.update();window.fixture.prefs.focus=true;window.update();});
  }
  assert.deepEqual((await shown()).map(row=>row[0]),expected);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(artifacts)await page.screenshot({path:path.join(artifacts,`${service?'service':'window'}-turn-captions-${language}-${theme}-${width}.png`),fullPage:true});
  // Migration from 0.4.21 has exactly the one confirmed selection, never a backfill.
  await page.evaluate(()=>{delete window.fixture.turnSelections;window.fixture.lastSelection={turnId:'synthetic-caption-turn-2',model:'synthetic-second',displayName:'Synthetic second',effort:null};window.fixture.viewRevision++;window.update();});
  assert.deepEqual((await shown()).map(row=>row[0]),['Synthetic second']);
  await page.evaluate(()=>{delete window.fixture.lastSelection;window.fixture.viewRevision++;window.update();});
  assert.equal(await page.$$('.turn-model-caption').then(rows=>rows.length),0,service?'Unrecorded turns show no caption':'Ordinary chat state has no captions');
  await page.evaluate(()=>{window.fixture=window.captionOriginal;delete window.captionOriginal;delete window.captionEarlier;delete window.captionNodes;window.update();});
};
