// Standalone stdio MCP adapter. No account information or CLI credentials cross this boundary.
const {request}=require('./mcp-bridge.cjs');
const text={type:'string',minLength:1};
const states=['queued','running','waiting_approval','completed','error','cancelled'];
// The stable launcher copy lives next to version.json; the packaged copy reads package.json.
const version=(()=>{for(const file of ['./version.json','../package.json'])try{return String(require(file).version);}catch{}return '0.0.0';})();
const tools=[
  ['reload_window','Reload the VS Code window that runs Rundix, for example after installing a new build. Refused while chats or MCP tasks are running unless force:true. The bridge is briefly unavailable afterwards; retry or use the --wait launcher, which waits through the reload.',{force:{type:'boolean'}},[]],
  ['list_models','List the Codex models available to the selected connection with their supported reasoning efforts and defaults, to choose model/effort for submit_task.',{},[]],
  ['close_task','Close the editor tab of a finished task (completed, cancelled or error) to avoid piling up tabs. The chat is kept; continue_task reopens it.',{taskId:text},['taskId']],
  ['submit_task','Queue a Codex task through the selected Rundix companion. Reuse requestId on retries. Choose model and effort per task from list_models: low for routine or mechanical work, medium by default, high only for genuinely hard reasoning (higher effort tends to over-reach); omit them to use the chat defaults.',{requestId:text,description:text,projectDirectory:text,acceptanceCriteria:text,model:text,effort:text},['requestId','description','projectDirectory','acceptanceCriteria']],
  ['get_task','Read status, progress, chatId, revision, final report and pending permission requests. Set brief:true to replace report with a compact reportSummary; default false returns the full report.',{taskId:text,brief:{type:'boolean',default:false}},['taskId']],
  ['wait_task','Block until the task needs attention (completed, error, cancelled or waiting_approval) or waitSeconds elapse, then return the same snapshot as get_task plus timedOut. Set brief:true for a compact reportSummary instead of report (default false). Use instead of polling get_task. Pass afterRevision from a previous snapshot to wait for a newer settled state. To wait in the background instead, run the launcher with --wait <taskId> [--brief] (Rundix docs/mcp.md).',{taskId:text,brief:{type:'boolean',default:false},waitSeconds:{type:'integer',minimum:1,maximum:1500},afterRevision:{type:'integer',minimum:0}},['taskId']],
  ['wait_tasks','Block until any of the given tasks needs attention (completed, error, cancelled or waiting_approval) or waitSeconds elapse. Returns {settled: snapshots of tasks needing attention, waiting: IDs still queued or running, timedOut}. Use it to supervise parallel tasks; brief:true returns reportSummary instead of report.',{taskIds:{type:'array',items:text,minItems:1,maxItems:50},brief:{type:'boolean',default:false},waitSeconds:{type:'integer',minimum:1,maximum:1500}},['taskIds']],
  ['continue_task','Continue the same chat after completion, or answer a pending permission request. Never infer user consent.',{requestId:text,taskId:text,clarification:text,approval:{type:'object',properties:{id:{type:['string','number']},decision:{type:'string',enum:['accept','decline','cancel']},answers:{type:'object',additionalProperties:{type:'string'}},skip:{type:'boolean'},content:{type:'object'}},required:['id'],additionalProperties:false}},['requestId','taskId']],
  ['cancel_task','Request interruption; call wait_task until cancellation is confirmed.',{requestId:text,taskId:text},['requestId','taskId']],
  ['list_tasks','List compact task summaries (no reports), newest created first. Filter by state or projectDirectory; pass nextCursor as cursor for the next page. Read a full report with get_task.',{limit:{type:'integer',minimum:1,maximum:100},state:{type:'string',enum:states},projectDirectory:text,cursor:text},[]],
].map(([name,description,properties,required])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}}));
function run(descriptor,input=process.stdin,output=process.stdout) {
  let buffer='',initialized=false;
  const send=value=>output.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
  const handle=async message=>{
    if (!message || message.jsonrpc!=='2.0' || typeof message.method!=='string') {send({id:message?.id??null,error:{code:-32600,message:'Invalid request'}});return;}
    if (message.id===undefined) return;
    const id=message.id;
    if (message.method==='initialize') {
      initialized=true;const supported=['2025-11-25','2025-06-18','2024-11-05'];
      send({id,result:{protocolVersion:supported.includes(message.params?.protocolVersion)?message.params.protocolVersion:supported[0],capabilities:{tools:{}},serverInfo:{name:'rundix',version}}});return;
    }
    if (!initialized) {send({id,error:{code:-32000,message:'Initialize first'}});return;}
    if (message.method==='ping') {send({id,result:{}});return;}
    if (message.method==='tools/list') {send({id,result:{tools}});return;}
    if (message.method!=='tools/call') {send({id,error:{code:-32601,message:'Method not found'}});return;}
    try {
      const tool=tools.find(t=>t.name===message.params?.name), args=message.params?.arguments || {};
      if(!tool || !args || Array.isArray(args) || typeof args!=='object' || Object.keys(args).some(k=>!Object.hasOwn(tool.inputSchema.properties,k)) || tool.inputSchema.required.some(k=>args[k]===undefined))throw Object.assign(Error('Invalid tool arguments'),{code:'invalid_argument'});
      const result=await request(descriptor,tool.name,args);
      send({id,result:{content:[{type:'text',text:JSON.stringify(result)}]}});
    } catch(error) {
      const coded=typeof error?.code==='string' && /^[a-z_]{1,40}$/.test(error.code);
      send({id,result:{isError:true,content:[{type:'text',text:coded?error.code+': '+error.message:'rejected: Request rejected. Check arguments, task state and connection in the Rundix MCP panel.'}]}});
    }
  };
  input.setEncoding('utf8');
  input.on('data',chunk=>{
    buffer+=chunk;
    if(Buffer.byteLength(buffer)>1024*1024){buffer='';send({id:null,error:{code:-32600,message:'Message too large'}});return;}
    let end;
    while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;try{void handle(JSON.parse(line));}catch{send({id:null,error:{code:-32700,message:'Parse error'}});}}
  });
}
// Background waiter for shells: survives a VS Code reload by retrying while the bridge is briefly unavailable.
// Exit codes: 0 completed, 2 waiting_approval, 3 error or cancelled, 4 timed out, 1 usage or rejected request.
const exitCodes={completed:0,waiting_approval:2,error:3,cancelled:3};
async function wait(descriptor,taskId,seconds,{call=request,output=process.stdout,pause=ms=>new Promise(r=>setTimeout(r,ms)),brief=false}={}) {
  const deadline=Date.now()+seconds*1000;
  let last=null;
  while(Date.now()<deadline) {
    const remaining=Math.ceil((deadline-Date.now())/1000);
    try {
      const ids=taskId.split(','), options={waitSeconds:Math.max(1,Math.min(remaining,1500)),...(brief ? {brief:true} : {})};
      if(ids.length>1) {
        // Several tasks: wake on the first that needs attention; an approval outranks a failure, which outranks success.
        last=await call(descriptor,'wait_tasks',{taskIds:ids,...options});
        if(!last.timedOut && last.settled.length){
          output.write(JSON.stringify(last)+'\n');
          const states=last.settled.map(t=>t.state);
          return states.includes('waiting_approval')?2:states.some(state=>exitCodes[state]===3)?3:0;
        }
        continue;
      }
      last=await call(descriptor,'wait_task',{taskId,...options});
      if(!last.timedOut && Object.hasOwn(exitCodes,last.state)){output.write(JSON.stringify(last)+'\n');return exitCodes[last.state];}
    } catch(error) {
      if(error.code==='response_too_large' && !brief){brief=true;continue;}
      if(error.code!=='bridge_unavailable'){output.write(JSON.stringify({error:error.message,code:error.code || 'rejected'})+'\n');return 1;}
      await pause(Math.min(5000,Math.max(0,deadline-Date.now())));
    }
  }
  output.write(JSON.stringify({...(last || {taskId}),timedOut:true})+'\n');
  return 4;
}
function argument(name){const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];}
if(require.main===module){
  const descriptor=argument('--bridge'), taskId=argument('--wait'), timeout=Number(argument('--timeout') ?? 3600);
  if(!descriptor || descriptor.startsWith('--') || (process.argv.includes('--wait') && (!taskId || taskId.startsWith('--') || !Number.isInteger(timeout) || timeout<1 || timeout>86400))){
    process.stderr.write('Usage: node mcp-server.cjs --bridge <bridge.json> [--wait <taskId>[,<taskId>...] [--timeout <seconds>] [--brief]]\n');process.exitCode=1;
  }else if(taskId)void wait(descriptor,taskId,timeout,{brief:process.argv.includes('--brief')}).then(code=>{process.exitCode=code;});
  else run(descriptor);
}
module.exports={run,tools,wait};
