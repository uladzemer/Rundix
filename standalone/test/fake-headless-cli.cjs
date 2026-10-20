// Explicitly synthetic app-server for headless-host/IPC tests. No network/auth
// files; input is ignored and every report is a fixed synthetic record.
const readline = require('node:readline');
const instance=require('node:crypto').randomUUID();
const threads = new Map(); let sequence = 0, turnSequence = 0;
const output = message => process.stdout.write(JSON.stringify(message) + '\n');
const pendingQuestions=new Map();
function complete(thread,turn){
  if(turn.status!=='inProgress')return;
  const item={id:'synthetic-report-'+turn.id,turnId:turn.id,type:'agentMessage',text:JSON.stringify({result:'Synthetic success',changedFiles:[],checks:['Synthetic check'],remainingIssues:[]})};
  thread.items.push(item);output({method:'item/completed',params:{threadId:thread.id,turnId:turn.id,item}});
  turn.status='completed';output({method:'turn/completed',params:{threadId:thread.id,turn:{...turn}}});
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
  if (message.method === 'account/login/start') result = {type:'chatgptAuthTokens'};
  if (message.method === 'account/read') result = {account:{type:'chatgpt', planType:'plus'}};
  if (message.method === 'account/rateLimits/read') result = {rateLimits:{primary:{usedPercent:1, windowDurationMins:300, resetsAt:Date.now() / 1000 + 3600}}};
  if (message.method === 'model/list') result = {data:[{model:'synthetic-model', isDefault:true, defaultReasoningEffort:'medium', supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};
  if (message.method === 'config/read') result = {config:{model:'synthetic-model', model_reasoning_effort:'medium'}};
  if (message.method === 'thread/start') {
    const thread = {id:'synthetic-thread-' + instance + '-' + ++sequence, cwd:params.cwd, turns:[], items:[]}; threads.set(thread.id, thread);
    result = {thread:{id:thread.id, cwd:thread.cwd}, model:'synthetic-model', reasoningEffort:'medium'};
  }
  const thread = threads.get(params.threadId);
  if (message.method === 'thread/resume') result = {thread:{id:thread.id, cwd:thread.cwd}, model:'synthetic-model', reasoningEffort:'medium'};
  if (message.method === 'thread/turns/list') result = {data:thread?.turns || []};
  if (message.method === 'thread/items/list') {
    const rows=(thread?.items || []).slice().reverse(),offset=params.cursor?Number(params.cursor.replace('synthetic-cursor-','')):0;
    result={data:rows.slice(offset,offset+(params.limit || 200)),nextCursor:offset+(params.limit || 200)<rows.length?'synthetic-cursor-'+(offset+(params.limit || 200)):null};
  }
  if (message.method === 'turn/start') {
    const turn = {id:'synthetic-turn-' + ++turnSequence, status:'inProgress'}; thread.turns.push(turn);
    output({id:message.id, result:{turn}});
    output({method:'turn/started', params:{threadId:thread.id, turn:{...turn}}});
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
      turn.status = 'completed'; output({method:'turn/completed', params:{threadId:thread.id, turn:{...turn}}});
    }, 60); return;
  }
  if (message.method === 'turn/interrupt') {
    const turn = thread?.turns.find(turn => turn.id === params.turnId);
    if (turn) {turn.status = 'interrupted'; output({method:'turn/completed', params:{threadId:thread.id, turn:{...turn}}});}
  }
  output({id:message.id, result});
});
