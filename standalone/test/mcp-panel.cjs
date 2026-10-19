const assert=require('node:assert/strict');
const {snapshot}=require('../runtime/mcp-panel.cjs');
const {activateCompanions}=require('../runtime/connection-companions.cjs');
(async()=>{
 let companionActivated=0,otherActivated=0;
 await activateCompanions({all:[
  {packageJSON:{extensionDependencies:['local-rundix-tools.rundix']},activate:async()=>{companionActivated++;}},
  {packageJSON:{extensionDependencies:[]},activate:async()=>{otherActivated++;}},
 ]},'local-rundix-tools.rundix');
 assert.equal(companionActivated,1);assert.equal(otherActivated,0);
 const state=snapshot({records:[{taskId:'synthetic-task',sessionKey:'synthetic-session',description:'Synthetic task <script>',state:'waiting_approval',projectDirectory:'D:/synthetic-project',updatedAt:1,connection:{id:'synthetic-pool',revision:'synthetic-private-revision'},operations:[{requestId:'synthetic-private-operation'}]}],language:'ru',connection:{id:'synthetic-pool',label:'Synthetic pool',external:true},connected:true,bridgeRunning:true,pending:()=>[{id:'synthetic-approval',method:'item/commandExecution/requestApproval',params:{syntheticPrivateField:'not-for-panel'}}]});
 assert.equal(state.tasks[0].title,'Synthetic task <script>');assert.equal(state.connected,true);
 const russian=require('../package.nls.ru.json');
 assert.match(russian['view.mcpTasks'],/[А-Яа-я]/);assert(!russian['command.mcpConnectPool'].includes('?'));
 assert(!JSON.stringify(state).includes('syntheticPrivateField'));assert(!JSON.stringify(state).includes('synthetic-private-revision'));assert(!JSON.stringify(state).includes('synthetic-private-operation'));
 console.log('MCP panel: installed companion discovery and minimal task projection passed.');
})().catch(()=>{console.error('MCP panel synthetic checks failed.');process.exitCode=1;});
