const readline=require('node:readline');const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id==='approval-1'&&!m.method){output({method:'item/agentMessage/delta',params:{threadId:'thread-a',itemId:'agent-1',delta:'Hello'}});output({method:'turn/completed',params:{threadId:'thread-a',turn:{id:'turn-1',status:'completed'}}});return;}
 if(m.id===undefined)return;
 if(m.method==='test/cwd'){output({id:m.id,result:{cwd:process.cwd()}});return;}
 if(m.method==='test/exit'){process.exit(2);return;}
 if(m.method==='turn/start'){
  output({id:m.id,result:{turn:{id:'turn-1',status:'inProgress'}}});
  output({method:'turn/started',params:{threadId:m.params.threadId,turn:{id:'turn-1'}}});
  output({id:'approval-1',method:'item/commandExecution/requestApproval',params:{threadId:m.params.threadId,turnId:'turn-1',itemId:'exec-1',command:'echo hello'}});return;
 }
 const response=JSON.stringify({id:m.id,result:m.method==='initialize'?{codexHome:'fixture'}:{ok:true}})+'\n';
 // Split every response across chunks to exercise streaming JSONL parsing.
 process.stdout.write(response.slice(0,5));setTimeout(()=>process.stdout.write(response.slice(5)),1);
});
