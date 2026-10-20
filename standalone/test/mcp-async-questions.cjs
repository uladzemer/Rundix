// Synthetic integration: real task orchestration/executor and the host's existing answer/steer paths.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {executor}=require('../runtime/mcp-executor.cjs');
const {McpTasks}=require('../runtime/mcp-tasks.cjs');
const {SessionStore}=require('../runtime/store.cjs');
const {canonical}=require('../runtime/task-directory.cjs');
const asyncQuestions=require('../runtime/async-questions.cjs'),questionRecords=require('../runtime/question-records.cjs');
const source=fs.readFileSync(path.join(__dirname,'../extension.cjs'),'utf8');
const answerStart=source.indexOf("    } else if(msg.action==='answerAsync') {");
const answerEnd=source.indexOf('    } else if (msg.action === "send"',answerStart);
const steerStart=source.indexOf('  async function steer('),steerEnd=source.indexOf('  async function drainFollowUps(',steerStart);
assert(answerStart>=0 && answerEnd>answerStart && steerStart>=0 && steerEnd>steerStart);
const question=id=>({id,type:'agentMessage',questions:[{title:'Synthetic choice',options:['Synthetic A (Recommended)','Synthetic B']},{title:'Synthetic details'}]});
const answers={'0':'Synthetic B','1':'Synthetic details answer'};
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rundix-mcp-questions-synthetic-'));
 let tasks;
 try{
  const project=canonical(root),store=new SessionStore(path.join(root,'records'));
  const connection={id:'synthetic-companion',owner:'synthetic-owner',revision:'synthetic-revision'};
  const requests=[],optionsSent=[],sessions=new Map(),pending=new Map();let sendFailure=false,steerFailure=null,finishOnRefusal=false,nextTurn=0,queued=0,sendGate=null,interrupts=0;
  const noop=()=>{},save=async()=>{};
  const server={request:async(method,params)=>{
   if(method==='turn/steer' && steerFailure){if(finishOnRefusal)s.busy=false;throw Error(steerFailure);}
   requests.push({method,params});return {turn:{id:'synthetic-reply-turn-'+(++nextTurn)}};
  }};
  const send=async(session,text,attached,options)=>{
   assert.equal(session.busy,false);if(sendFailure)throw Error('Synthetic send failure');
   if(sendGate)await sendGate;
   session.stopRequested=false;
   optionsSent.push(options);
   const result=await server.request('turn/start',{threadId:session.id,input:[{type:'text',text}]});
   session.turnId=result.turn.id;session.busy=true;session.error=null;return {turnId:session.turnId};
  };
  const context={asyncQuestions,questionRecords,mcpTasks:null,preflight:{preparing:()=>false},publish:noop,save,send,server,
   locale:{t:text=>text},buildInput:text=>[{type:'text',text}],queueFollowUp:async()=>{queued++;}};
  context.steer=vm.runInNewContext('('+source.slice(steerStart,steerEnd).trim()+')',context);
  const handle=vm.runInNewContext('(async function(s,msg){'+source.slice(answerStart+"    } else if(msg.action==='answerAsync') {".length,answerEnd)+'})',context);
  const adapter=executor({connections:{selection:()=>connection},sessions,store,create(){throw Error('Unexpected synthetic session creation');},send,
   resume:async()=>{throw Error('Unexpected resume');},handle:async(session,msg)=>{
    if(msg.action==='stop'){session.stopRequested=true;if(session.busy)interrupts++;return;}
    return handle(session,msg);
   },pending,save,alive:()=>true});
  const s={key:'synthetic-session',id:'synthetic-chat',cwd:project,loaded:true,busy:false,lastTurnStatus:'completed',items:[question('synthetic-idle-question')],
   draft:'Synthetic preserved draft',attachments:[{id:'synthetic-attachment'}],prefs:{}};
  const ordinary={key:'synthetic-ordinary',id:'synthetic-ordinary-chat',items:[question('synthetic-ordinary-question')],busy:false,attachments:[],prefs:{}};
  sessions.set(s.key,s);sessions.set(ordinary.key,ordinary);
  tasks=new McpTasks({store,adapter});tasks.schedule=()=>{};
  const task={taskId:'synthetic-task',sessionKey:s.key,projectDirectory:project,connection,state:'running',operations:[],createdAt:1,turnId:'synthetic-original-turn'};
  tasks.tasks.set(task.taskId,task);
  const tick=()=>tasks.tick();
  const approval=(requestId,id,fields)=>tasks.call('continue_task',{taskId:task.taskId,requestId,approval:{id,...fields}});
  const id='async-question:synthetic-idle-question';
  const ordinaryBefore=JSON.stringify(ordinary);
  assert.deepEqual(adapter.pending(task),[{id,method:'rundix/asyncQuestion',params:{threadId:s.id,questions:[
   {id:'0',title:'Synthetic choice',options:['Synthetic A (Recommended)','Synthetic B']},{id:'1',title:'Synthetic details',options:[]}]}}]);
  await tick();assert.equal(task.state,'waiting_approval');assert.equal(task.report,undefined);
  assert.equal(tasks.call('get_task',{taskId:task.taskId}).pendingRequests[0].id,id);
  await assert.rejects(()=>approval('synthetic-invalid',id,{answers:{'0':'Synthetic B'}}),/Answer every question/);
  assert.equal(requests.length,0);assert.equal(adapter.pending(task).length,1);
  await assert.rejects(async()=>approval('synthetic-cross-chat','async-question:synthetic-ordinary-question',{answers}),/no longer pending/);
  sendFailure=true;
  await assert.rejects(()=>approval('synthetic-send-failure',id,{answers}),/Synthetic send failure/);
  assert.equal(s.asyncQuestionSending,null);assert.equal(adapter.pending(task).length,1);
  sendFailure=false;
  await approval('synthetic-idle-answer',id,{answers});
  assert.equal(task.state,'running');assert.equal(adapter.pending(task).length,0);
  assert.equal(task.turnId,s.turnId);assert.notEqual(task.turnId,'synthetic-original-turn');
  assert.equal(optionsSent[0].taskId,task.taskId);assert.equal(optionsSent[0].projectDirectory,project);
  assert.deepEqual(optionsSent[0].requiredConnection,connection);assert(optionsSent[0].outputSchema);
  assert.equal(requests.at(-1).method,'turn/start');assert.equal(requests.at(-1).params.threadId,s.id);
  const reply=JSON.parse(requests.at(-1).params.input[0].text.split('\n')[1]);
  assert.equal(reply[0].answer,answers['0']);assert.deepEqual(JSON.parse(reply[1].questionItemId),['request_user_input_async','synthetic-idle-question',1]);
  assert.equal(s.asyncQuestionReplies['synthetic-idle-question'],'sent');assert.equal(s.questionHistory[0].answers['1'],answers['1']);
  assert.equal(s.draft,'Synthetic preserved draft');assert.equal(s.attachments.length,1);
  await tick();assert.equal(task.state,'running');
  s.busy=false;s.lastTurnStatus='completed';s.items.push({id:'synthetic-report',type:'agentMessage',turnId:task.turnId,text:JSON.stringify({result:'Synthetic completion',changedFiles:[],checks:[],remainingIssues:[]})});
  await tick();assert.equal(task.state,'completed');assert.equal(task.report.result,'Synthetic completion');

  const waiting=async(itemId,busy=true)=>{s.items.push(question(itemId));s.busy=busy;s.lastTurnStatus='completed';task.state='running';await tick();assert.equal(task.state,'waiting_approval');};
  await waiting('synthetic-active-question');
  const beforeTurn=task.turnId;
  await approval('synthetic-active-answer','async-question:synthetic-active-question',{answers});
  assert.equal(requests.at(-1).method,'turn/steer');assert.equal(requests.at(-1).params.expectedTurnId,s.turnId);
  assert.equal(task.turnId,beforeTurn);assert.equal(adapter.pending(task).length,0);
  await waiting('synthetic-skip-question',false);
  await approval('synthetic-skip-answer','async-question:synthetic-skip-question',{skip:true});
  assert(JSON.parse(requests.at(-1).params.input[0].text.split('\n')[1]).every(row=>row.answer===questionRecords.SKIPPED));
  assert.equal(s.asyncQuestionReplies['synthetic-skip-question'],'skipped');assert.equal(adapter.pending(task).length,0);

  await waiting('synthetic-race-question');steerFailure='no active turn';
  await assert.rejects(()=>approval('synthetic-race-refusal','async-question:synthetic-race-question',{answers}),/turn is finishing/);
  assert.equal(queued,0);assert.equal(adapter.pending(task).length,1);
  finishOnRefusal=true;
  await approval('synthetic-race-retry','async-question:synthetic-race-question',{answers});
  assert.equal(requests.at(-1).method,'turn/start');assert.equal(optionsSent.at(-1).taskId,task.taskId);assert.equal(adapter.pending(task).length,0);
  steerFailure=null;finishOnRefusal=false;
  await waiting('synthetic-timeout-question');steerFailure='Synthetic timeout';
  await assert.rejects(()=>approval('synthetic-timeout','async-question:synthetic-timeout-question',{answers}),/Synthetic timeout/);
  assert.equal(adapter.pending(task).length,1);assert.equal(queued,0);steerFailure=null;
  await approval('synthetic-timeout-retry','async-question:synthetic-timeout-question',{answers});

  // Existing reply metadata/transcripts remain authoritative; malformed questions are ignored.
  const historical=question('synthetic-historical-question');
  s.items.push(historical,{id:'synthetic-historical-reply',type:'userMessage',text:asyncQuestions.buildReply(historical,answers)},
   {...question('synthetic-invalid-question'),questions:[{title:'Synthetic malformed',options:[{}]}]});
  assert.equal(adapter.pending(task).length,0);
  assert.equal(JSON.stringify(ordinary),ordinaryBefore,'MCP operations leave ordinary chats untouched');
  pending.set('synthetic-blocking',{id:'synthetic-blocking',method:'item/tool/requestUserInput',params:{threadId:s.id,questions:[]}});
  pending.set('synthetic-other-blocking',{id:'synthetic-other-blocking',method:'item/tool/requestUserInput',params:{threadId:ordinary.id}});
  assert.deepEqual(adapter.pending(task).map(row=>row.id),['synthetic-blocking']);pending.clear();

  await waiting('synthetic-cancelled-question',false);
  await tasks.call('cancel_task',{taskId:task.taskId,requestId:'synthetic-cancel-idle-question'});
  await tick();assert.equal(task.state,'cancelled','An idle async question must not prevent cancellation');
  assert.equal(s.busy,false);
  task.cancelRequested=false;s.stopRequested=false;task.state='running';await tick();
  let releaseSend;sendGate=new Promise(resolve=>{releaseSend=resolve;});
  const replyDuringCancel=approval('synthetic-answer-during-cancel','async-question:synthetic-cancelled-question',{answers});
  await tasks.call('cancel_task',{taskId:task.taskId,requestId:'synthetic-cancel-during-reply'});
  assert.equal(interrupts,0,'Preparation has no active turn to interrupt yet');
  releaseSend();await replyDuringCancel;sendGate=null;
  assert.equal(interrupts,1,'Cancellation during reply preparation interrupts the accepted turn');
  assert.equal(s.stopRequested,true);assert.equal(s.busy,true);
  s.busy=false;s.lastTurnStatus='interrupted';await tick();assert.equal(task.state,'cancelled');

  // The same host handler keeps ordinary active/idle and deferred delivery behavior.
  await handle(ordinary,{action:'answerAsync',itemId:'synthetic-ordinary-question',answers});
  assert.equal(optionsSent.at(-1).taskId,undefined);assert.equal(optionsSent.at(-1).includeIde,false);
  ordinary.items.push(question('synthetic-ordinary-active'));
  await handle(ordinary,{action:'answerAsync',itemId:'synthetic-ordinary-active',answers});
  assert.equal(requests.at(-1).method,'turn/steer');assert.equal(requests.at(-1).params.threadId,ordinary.id);
  ordinary.items.push(question('synthetic-ordinary-deferred'));steerFailure='no active turn';
  await handle(ordinary,{action:'answerAsync',itemId:'synthetic-ordinary-deferred',answers});
  assert.equal(queued,1);assert.equal(ordinary.asyncQuestionReplies['synthetic-ordinary-deferred'],'queued');
  console.log('MCP async questions: waiting_approval after completion, continue_task replies/skip, scoped reply turns, failure/cancellation recovery and ordinary chats passed.');
 }finally{tasks?.dispose();fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
