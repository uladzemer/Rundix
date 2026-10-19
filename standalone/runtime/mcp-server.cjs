// Standalone stdio MCP adapter. No account information or CLI credentials cross this boundary.
const {request}=require('./mcp-bridge.cjs');
const text={type:'string',minLength:1};
const tools=[
  ['submit_task','Queue a Codex task through the selected Rundix companion. Reuse requestId on retries.',{requestId:text,description:text,projectDirectory:text,acceptanceCriteria:text,model:text,effort:text},['requestId','description','projectDirectory','acceptanceCriteria']],
  ['get_task','Read status, progress, chatId, final report and pending permission requests.',{taskId:text},['taskId']],
  ['continue_task','Continue the same chat after completion, or answer a pending permission request. Never infer user consent.',{requestId:text,taskId:text,clarification:text,approval:{type:'object',properties:{id:{type:['string','number']},decision:{type:'string',enum:['accept','decline','cancel']},answers:{type:'object',additionalProperties:{type:'string'}},skip:{type:'boolean'},content:{type:'object'}},required:['id'],additionalProperties:false}},['requestId','taskId']],
  ['cancel_task','Request interruption; poll get_task until cancellation is confirmed.',{requestId:text,taskId:text},['requestId','taskId']],
  ['list_tasks','List current and recent tasks, newest first.',{limit:{type:'integer',minimum:1,maximum:100}},[]],
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
      send({id,result:{protocolVersion:supported.includes(message.params?.protocolVersion)?message.params.protocolVersion:supported[0],capabilities:{tools:{}},serverInfo:{name:'rundix',version:require('../package.json').version}}});return;
    }
    if (!initialized) {send({id,error:{code:-32000,message:'Initialize first'}});return;}
    if (message.method==='ping') {send({id,result:{}});return;}
    if (message.method==='tools/list') {send({id,result:{tools}});return;}
    if (message.method!=='tools/call') {send({id,error:{code:-32601,message:'Method not found'}});return;}
    try {
      const tool=tools.find(t=>t.name===message.params?.name), args=message.params?.arguments || {};
      if(!tool || !args || Array.isArray(args) || typeof args!=='object' || Object.keys(args).some(k=>!Object.hasOwn(tool.inputSchema.properties,k)) || tool.inputSchema.required.some(k=>args[k]===undefined))throw Error('Invalid tool arguments');
      const result=await request(descriptor,tool.name,args);
      send({id,result:{content:[{type:'text',text:JSON.stringify(result)}]}});
    } catch(error) {send({id,result:{isError:true,content:[{type:'text',text:error.message}]}});}
  };
  input.setEncoding('utf8');
  input.on('data',chunk=>{
    buffer+=chunk;
    if(Buffer.byteLength(buffer)>1024*1024){buffer='';send({id:null,error:{code:-32600,message:'Message too large'}});return;}
    let end;
    while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;try{void handle(JSON.parse(line));}catch{send({id:null,error:{code:-32700,message:'Parse error'}});}}
  });
}
if(require.main===module){const index=process.argv.indexOf('--bridge');if(index<0 || !process.argv[index+1]){process.stderr.write('Usage: node mcp-server.cjs --bridge <bridge.json>\n');process.exitCode=1;}else run(process.argv[index+1]);}
module.exports={run,tools};
