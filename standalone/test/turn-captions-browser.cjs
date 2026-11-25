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
  await page.evaluate(()=>{
    window.captionBase=window.fixture;
    window.fixture={...window.fixture,turnSelections:window.fixture.turnSelections.map(row=>row.turnId==='synthetic-caption-turn-2'?{...row,steered:true}:row),
      items:[...window.fixture.items.slice(0,3),{id:'synthetic-interleaved-agent',type:'agentMessage',turnId:'synthetic-other-turn',text:'Synthetic interleaved turn'},...window.fixture.items.slice(3)]};
    window.fixture.viewRevision++;window.update();
  });
  assert.deepEqual(await shown(),[[expected[0],'synthetic-caption-user-1','synthetic-caption-turn-1']],
    'An attempted steer removes the displayed caption, including its second user row');
  await page.evaluate(()=>{window.fixture.items.find(item=>item.id==='synthetic-caption-agent-2').text+=' Synthetic next delta';window.fixture.viewRevision++;window.update();});
  assert.deepEqual((await shown()).map(row=>row[0]),[expected[0]],'Streaming does not restore a steered caption');
  await page.evaluate(()=>{
    window.fixture={...window.fixture,generation:'synthetic-clipped-steered-generation',historyTruncated:true,
      cursor:'synthetic-clipped-page',items:window.fixture.items.filter(item=>item.id==='synthetic-caption-steer')};
    window.update();
  });
  assert.equal((await shown()).length,0,'A clipped later user row of a steered turn has no caption');
  const earlierSteered=()=>page.evaluate(service=>{
    const rows=window.captionBase.items.filter(item=>['synthetic-caption-user-2','synthetic-caption-agent-2'].includes(item.id));
    if(service)window.dispatchEvent(new MessageEvent('message',{data:{type:'chatHistory',data:{items:rows,cursor:null}}}));
    else{window.fixture.items=[...rows,...window.fixture.items];window.update();}
  },service);
  await earlierSteered();
  assert.equal((await shown()).length,0,'Loading the true first user row does not restore a steered caption');
  await page.evaluate(()=>{window.fixture.viewRevision++;window.update();});
  assert.equal((await shown()).length,0,'A later snapshot keeps the steered caption hidden');
  await page.evaluate(()=>{
    const text='Synthetic unsteered message',turnId='synthetic-caption-turn-3';
    window.fixture={...window.fixture,generation:'synthetic-unsteered-generation',items:[
      {id:'synthetic-caption-user-3',type:'userMessage',turnId,text,content:[{type:'text',text}]},
      {id:'synthetic-caption-other-turn',type:'agentMessage',turnId:'synthetic-caption-turn-4',text},
      {id:'synthetic-caption-late-agent',type:'agentMessage',turnId,text}],
      turnSelections:[{turnId,model:'synthetic-third',displayName:'Synthetic third',effort:'medium'}]};
    window.update();
  });
  const third='Synthetic third · '+(language==='ru'?'Среднее':'Medium');
  assert.deepEqual(await shown(),[[third,'synthetic-caption-user-3','synthetic-caption-turn-3']],
    'A clipped unsteered turn has its caption despite non-contiguous T, U, late T rows');
  await page.evaluate(()=>{window.fixture.items.at(-1).text+=' Synthetic streamed delta';window.fixture.viewRevision++;window.update();});
  assert.deepEqual(await shown(),[[third,'synthetic-caption-user-3','synthetic-caption-turn-3']]);
  await page.evaluate(()=>{window.fixture=window.captionBase;delete window.captionBase;window.fixture.viewRevision++;window.update();});
  // Migration from 0.4.21 has exactly the one confirmed selection, never a backfill.
  await page.evaluate(()=>{delete window.fixture.turnSelections;window.fixture.lastSelection={turnId:'synthetic-caption-turn-2',model:'synthetic-second',displayName:'Synthetic second',effort:null};window.fixture.viewRevision++;window.update();});
  assert.deepEqual((await shown()).map(row=>row[0]),['Synthetic second']);
  await page.evaluate(()=>{delete window.fixture.lastSelection;window.fixture.viewRevision++;window.update();});
  assert.equal(await page.$$('.turn-model-caption').then(rows=>rows.length),0,service?'Unrecorded turns show no caption':'Ordinary chat state has no captions');
  await page.evaluate(()=>{window.fixture=window.captionOriginal;delete window.captionOriginal;delete window.captionEarlier;delete window.captionNodes;window.update();});
};
