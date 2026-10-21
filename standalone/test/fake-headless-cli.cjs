// Explicitly synthetic app-server for headless-host/IPC tests. No network/auth
// files; input is ignored and every report is a fixed synthetic record.
const readline = require('node:readline');
const fs=require('node:fs'),path=require('node:path');
const instance=require('node:crypto').randomUUID();
const threads = new Map(); let sequence = 0, turnSequence = 0;
const loaded=new Set();
let account='primary';
const quotaFile=process.env.RUNDIX_SYNTHETIC_QUOTA_FILE;
function quota(){try{return JSON.parse(fs.readFileSync(quotaFile,'utf8'));}catch{return {};}}
const rolloutRoot=process.env.RUNDIX_SYNTHETIC_ROLLOUTS;
if(rolloutRoot)fs.mkdirSync(rolloutRoot,{recursive:true});
function persist(thread){if(rolloutRoot)fs.writeFileSync(path.join(rolloutRoot,thread.id+'.json'),JSON.stringify(thread));}
function readThread(id){
  if(threads.has(id))return threads.get(id);
  if(!rolloutRoot || typeof id!=='string' || !/^synthetic-thread-[a-f0-9-]+-\d+$/.test(id))return;
  try{
    const thread=JSON.parse(fs.readFileSync(path.join(rolloutRoot,id+'.json'),'utf8'));
    for(const turn of thread.turns)if(turn.status==='inProgress')turn.status='interrupted';
    threads.set(id,thread);persist(thread);return thread;
  }catch{}
}
const output = message => process.stdout.write(JSON.stringify(message) + '\n');
const pendingQuestions=new Map();
function complete(thread,turn){
  if(turn.status!=='inProgress')return;
  const item={id:'synthetic-report-'+turn.id,turnId:turn.id,type:'agentMessage',text:JSON.stringify({result:'Synthetic success',changedFiles:[],checks:['Synthetic check'],remainingIssues:[]})};
  thread.items.push(item);output({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item}});
  turn.status='completed';persist(thread);output({method:'turn/completed',params:{threadId:thread.id,turn:{...turn}}});
}
readline.createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if(!message.method && pendingQuestions.has(message.id)){
    const {thread,turn}=pendingQuestions.get(message.id);pendingQuestions.delete(message.id);
    if(!message.result)throw Error('Synthetic answer missing');setTimeout(()=>complete(thread,turn),30);return;
  }
  if (message.id === 'synthetic-refresh-request' && !message.method) {
    if (!message.error) throw Error('Synthetic refresh expected refusal');
    return;
  }
  if (!message.method || message.id === undefined) return;
  const params = message.params || {}; let result = {};
  if (process.env.RUNDIX_SYNTHETIC_COLD_ACCOUNT_UPDATE === '1') {
    if (message.method === 'account/login/start') {
      output({method:'account/updated',params:{authMode:'chatgptAuthTokens'}});
      setTimeout(() => output({id:message.id,result:{type:'chatgptAuthTokens'}}),50);
      return;
    }
    if (['model/list','config/read'].includes(message.method)) {
      const result=message.method==='model/list'
        ? {data:[{model:'synthetic-model',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]}
        : {config:{model:'synthetic-model',model_reasoning_effort:'medium'}};
      setTimeout(() => output({id:message.id,result}),180);
      return;
    }
  }
  if (message.method === 'account/login/start') {account=params.chatgptAccountId?.replace('synthetic-chatgpt-','') || 'primary';result = {type:'chatgptAuthTokens'};}
  if (message.method === 'account/read') result = {account:{type:'chatgpt', planType:'plus'}};
  if (message.method === 'account/rateLimits/read') result = {rateLimits:{primary:{usedPercent:1, windowDurationMins:300, resetsAt:Date.now() / 1000 + 3600}}};
  if (message.method === 'account/rateLimits/read' && quotaFile) {
    const value=quota();result.rateLimits.primary.usedPercent=value.exhausted?.includes(account)?100:1;
    result.rateLimits.primary.resetsAt=(value.resetAt || Date.now()+3600000)/1000;
  }
  if (message.method === 'model/list') result = {data:[{model:'synthetic-model', isDefault:true, defaultReasoningEffort:'medium', supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};
  if (message.method === 'config/read') result = {config:{model:'synthetic-model', model_reasoning_effort:'medium'}};
  if (message.method === 'thread/start') {
    const thread = {id:'synthetic-thread-' + instance + '-' + ++sequence, cwd:params.cwd, turns:[], items:[]}; threads.set(thread.id, thread);
    loaded.add(thread.id);persist(thread);
    result = {thread:{id:thread.id, cwd:thread.cwd}, model:'synthetic-model', reasoningEffort:'medium'};
  }
  const thread = readThread(params.threadId);
  if (message.method === 'thread/read') result={thread:{id:thread?.id,cwd:thread?.cwd,turns:params.includeTurns?thread?.turns:[]}};
  if (message.method === 'thread/resume') {
    if(!thread){output({id:message.id,error:{code:-32000,message:'Synthetic thread unavailable'}});return;}
    loaded.add(thread.id);result = {thread:{id:thread.id, cwd:thread.cwd,status:{type:thread.turns.some(t=>t.status==='inProgress')?'active':'idle'}}, model:'synthetic-model', reasoningEffort:'medium'};
  }
  if (message.method === 'thread/turns/list') result = {data:(thread?.turns || []).slice().reverse()};
  if (message.method === 'thread/items/list') {
    const rows=(thread?.items || []).slice().reverse(),offset=params.cursor?Number(params.cursor.replace('synthetic-cursor-','')):0;
    result={data:rows.slice(offset,offset+(params.limit || 200)),nextCursor:offset+(params.limit || 200)<rows.length?'synthetic-cursor-'+(offset+(params.limit || 200)):null};
  }
  if (message.method === 'turn/start') {
    if(!thread || !loaded.has(thread.id)){output({id:message.id,error:{code:-32000,message:'Synthetic thread must be resumed'}});return;}
    const turn = {id:'synthetic-turn-' + instance + '-' + ++turnSequence, status:'inProgress'}; thread.turns.push(turn);persist(thread);
    output({id:message.id, result:{turn}});
    output({method:'turn/started', params:{threadId:thread.id, turn:{...turn}}});
    if(process.env.RUNDIX_SYNTHETIC_LIMIT_ONCE==='1' && thread.turns.length===1) {
      setTimeout(()=>{
        turn.status='failed';turn.error={message:'Synthetic usage limit',codexErrorInfo:'usageLimitExceeded'};persist(thread);
        output({method:'error',params:{threadId:thread.id,turnId:turn.id,error:turn.error,willRetry:false}});
        if(process.env.RUNDIX_SYNTHETIC_EXIT_ON_LIMIT==='1'){setTimeout(()=>process.exit(0),20);return;}
        output({method:'turn/completed',params:{threadId:thread.id,turn:{...turn}}});
      },60);return;
    }
    if((process.env.RUNDIX_SYNTHETIC_QUESTION==='1' || process.env.RUNDIX_SYNTHETIC_APPROVAL==='1') && turnSequence===1){
      const item={id:'synthetic-user-'+turn.id,type:'userMessage',turnId:turn.id,content:params.input || []};thread.items.push(item);
      output({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item}});
      const id='synthetic-question-'+turn.id;pendingQuestions.set(id,{thread,turn});
      output({id,method:process.env.RUNDIX_SYNTHETIC_QUESTION==='1'?'item/tool/requestUserInput':'item/commandExecution/requestApproval',
        params:{threadId:thread.id,turnId:turn.id,itemId:'synthetic-operation',
          ...(process.env.RUNDIX_SYNTHETIC_QUESTION==='1'?{questions:[{id:'synthetic-choice',question:'Synthetic choice?',options:[{label:'Synthetic option',description:'Synthetic option description'}]}]}:{command:'synthetic-check',availableDecisions:['accept','decline']})}});return;
    }
    if(process.env.RUNDIX_SYNTHETIC_HOLD==='1')return;
    if (process.env.RUNDIX_SYNTHETIC_REFRESH === '1') {
      output({id:'synthetic-refresh-request', method:'account/chatgptAuthTokens/refresh', params:{reason:'synthetic-refresh'}});
      setTimeout(() => {turn.status = 'failed';output({method:'turn/completed', params:{threadId:thread.id, turn:{...turn}}});}, 250);
      return;
    }
    setTimeout(() => {
      if (turn.status !== 'inProgress') return;
      const item = {id:'synthetic-report-' + turn.id, turnId:turn.id, type:'agentMessage',
        text:JSON.stringify({result:'Synthetic success', changedFiles:[], checks:['Synthetic check'], remainingIssues:[]})};
      thread.items.push(item); output({method:'item/completed', params:{threadId:thread.id, turnId:turn.id, item}});
      turn.status = 'completed';persist(thread); output({method:'turn/completed', params:{threadId:thread.id, turn:{...turn}}});
    }, 60); return;
  }
  if (message.method === 'turn/interrupt') {
    const turn = thread?.turns.find(turn => turn.id === params.turnId);
    if (turn) {turn.status = 'interrupted';persist(thread); output({method:'turn/completed', params:{threadId:thread.id, turn:{...turn}}});}
  }
  output({id:message.id, result});
});
