const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const {runService}=require('../runtime/service-main.cjs');
const {ServiceWindowClient}=require('../runtime/service-window-client.cjs');
const {fixture}=require('./service-fixture.cjs');
async function scenario(kind){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-service-chat-synthetic-'));
  const data=fixture(root,{cliEnv:{[kind==='question'?'RUNDIX_SYNTHETIC_QUESTION':'RUNDIX_SYNTHETIC_APPROVAL']:'1'}}),clients=[];let service;
  const a=path.join(root,'synthetic-a'),b=path.join(root,'synthetic-b');fs.mkdirSync(a);fs.mkdirSync(b);
  const window=folder=>{const client=new ServiceWindowClient({root,trusted:true,workspaceFolders:[pathToFileURL(folder).href]});clients.push(client);return client;};
  try{
    service=await runService({root,hostOptions:data.hostOptions});
    const wa=window(a),wa2=window(a),wb=window(b);await Promise.all(clients.map(client=>client.start()));
    const sa=wa.spaces[0].spaceId,sb=wb.spaces[0].spaceId;
    const task=await wa.call(sa,'submit_task',{requestId:'synthetic-chat-submit',description:'Synthetic chat task',acceptanceCriteria:'Synthetic checks',projectDirectory:a});
    const pending=await wa.call(sa,'wait_task',{taskId:task.taskId,waitSeconds:5});assert.equal(pending.state,'waiting_approval');
    const chat=await wa.chat(sa,'chat.open',{taskId:task.taskId});await wa2.chat(sa,'chat.open',{taskId:task.taskId});
    assert.equal(chat.owner,'service');assert(chat.items.some(item=>item.type==='userMessage'));assert.equal(chat.pendingRequests.length,1);
    await assert.rejects(wb.chat(sb,'chat.open',{taskId:task.taskId}),{code:'unknown_task'});
    let changes=0;wa.on('chatChanged',()=>changes++);
    const approval={id:chat.pendingRequests[0].id,...(kind==='question'?{answers:{'synthetic-choice':'Synthetic option'}}:{decision:'accept'})};
    const answered=await Promise.allSettled([wa.call(sa,'continue_task',{taskId:task.taskId,requestId:'synthetic-answer-a',approval}),wa2.call(sa,'continue_task',{taskId:task.taskId,requestId:'synthetic-answer-a2',approval})]);
    assert.equal(answered.filter(result=>result.status==='fulfilled').length,1,'Two windows send only one answer');
    const done=await wa.call(sa,'wait_task',{taskId:task.taskId,waitSeconds:5});assert.equal(done.state,'completed');assert(changes>0);
    const finished=await wa.chat(sa,'chat.subscribe',{taskId:task.taskId});assert(finished.items.some(item=>item.type==='agentMessage'));
    const latest=await wa.chat(sa,'chat.history',{taskId:task.taskId,cursor:'@latest'});assert(latest.items.some(item=>item.type==='agentMessage'));
    const escaped=Array.from({length:20},(_,index)=>({id:'synthetic-escaped-'+index,type:'agentMessage',text:'\n\\"\u0001'.repeat(5000)}));
    const escapedPage=require('../runtime/service-projection.cjs').transcript(escaped);
    assert.equal(escapedPage.items.length,20,'Escaped JSON cannot drop history page rows');
    assert(escapedPage.items.every(item=>Buffer.byteLength(JSON.stringify(item))<=16384));
    await wa.call(sa,'continue_task',{taskId:task.taskId,requestId:'synthetic-chat-followup',clarification:'Synthetic continuation'});
    const continued=await wa.call(sa,'wait_task',{taskId:task.taskId,waitSeconds:5});assert.equal(continued.chatId,chat.chatId);
    const key=service.host.mcp.tasks.tasks.get(task.taskId).sessionKey;
    const session=service.host.core.sessions.get(key) || service.host.core.store.session(key);
    session.items=Array.from({length:250},(_,index)=>({id:'synthetic-item-'+index,type:'agentMessage',text:'😀'.repeat(10000)}));
    service.host.core.store.saveSession(session);
    const bounded=await wa.chat(sa,'chat.subscribe',{taskId:task.taskId});
    assert(bounded.historyTruncated && bounded.itemsTruncated);assert(bounded.items.length<=200);
    assert.equal(bounded.cursor,'@latest','Clipped cache can restart normal CLI pagination without skipping rows');
    assert(Buffer.byteLength(JSON.stringify(bounded))<=768*1024);
    assert(bounded.items.every(item=>Buffer.byteLength(item.text)<=16384 && !item.text.includes('\ufffd')));
    assert.equal(session.items.length,250,'Window projection never shortens stored transcript');
    const closed=await wa.call(sa,'close_task',{taskId:task.taskId});assert.equal(closed.windowsNotified,2);
    assert.equal((await wa.chat(sa,'chat.subscribe',{taskId:task.taskId})).closed,true);
    await wa.chat(sa,'chat.unsubscribe',{taskId:task.taskId});
    assert.equal((await wa2.call(sa,'get_task',{taskId:task.taskId})).state,'completed');
  }finally{clients.forEach(client=>client.close());await service?.shutdown();await data.close();assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('rundix-service-chat-synthetic-'));fs.rmSync(root,{recursive:true,force:true});}
}
Promise.resolve().then(()=>scenario('question')).then(()=>scenario('approval')).then(()=>console.log('PASS service task chats: scoped transcript, window continuation, concurrent question/approval answers once, bounded huge items and close notifications.')).catch(error=>{console.error(error);process.exitCode=1;});
