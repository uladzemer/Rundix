const assert=require('node:assert/strict');
const {snapshot,serviceSnapshot}=require('../runtime/mcp-panel.cjs');
const {preferredModel}=require('../runtime/mcp-model.cjs');
const {activateCompanions}=require('../runtime/connection-companions.cjs');
(async()=>{
 let companionActivated=0,otherActivated=0;
 await activateCompanions({all:[
  {packageJSON:{extensionDependencies:['local-rundix-tools.rundix']},activate:async()=>{companionActivated++;}},
  {packageJSON:{extensionDependencies:[]},activate:async()=>{otherActivated++;}},
 ]},'local-rundix-tools.rundix');
 assert.equal(companionActivated,1);assert.equal(otherActivated,0);
 const lastSelection={model:'synthetic-model',displayName:'Synthetic model',effort:'medium',turnId:'synthetic-turn'};
 const modelDefaults={model:null,effort:'auto'},models={status:'ready',list:[{model:'synthetic-model',displayName:'Synthetic model',defaultEffort:'medium',efforts:['medium']}]};
 const state=snapshot({modelDefaults,models,records:[{lastSelection,taskId:'synthetic-task',sessionKey:'synthetic-session',description:'Synthetic task <script>',state:'waiting_approval',projectDirectory:'D:/synthetic-project',updatedAt:1,connection:{id:'synthetic-pool',revision:'synthetic-private-revision'},operations:[{requestId:'synthetic-private-operation'}]}],language:'ru',connection:{id:'synthetic-pool',label:'Synthetic pool',external:true},connected:true,bridgeRunning:true,pending:()=>[{id:'synthetic-approval',method:'item/commandExecution/requestApproval',params:{syntheticPrivateField:'not-for-panel'}}]});
 assert.equal(state.tasks[0].title,'Synthetic task <script>');assert.equal(state.connected,true);
 assert.deepEqual(state.tasks[0].lastSelection,lastSelection);assert.deepEqual(state.modelDefaults,modelDefaults);assert.deepEqual(state.models,models);
 assert.equal(state.preferredModel,preferredModel);assert.equal(serviceSnapshot({}).preferredModel,preferredModel);
 const {panelDefaults,validateDefaults}=require('../runtime/mcp-panel-models.cjs');
 assert.deepEqual(panelDefaults(()=>({workspaceValue:'synthetic-ignored'})),{model:null,effort:'auto'});
 assert.deepEqual(panelDefaults(key=>({globalValue:key==='mcpDefaultModel'?'':'high'})),{model:'',effort:'high'});
 for(const [model,effort]of [['synthetic-model','medium'],['','medium'],[null,'auto'],[null,'medium']])validateDefaults(model,effort,models);
 for(const [model,effort]of [['synthetic-missing','auto'],['synthetic-model','high'],[null,'ultra'],['','ultra'],[' synthetic-model ','auto'],[42,'auto'],[null,'invalid']])assert.throws(()=>validateDefaults(model,effort,models),{code:'invalid_selection'});
 const withPreferred={status:'ready',list:[...models.list,{model:preferredModel,efforts:['high']}]};
 validateDefaults(null,'high',withPreferred);
 assert.throws(()=>validateDefaults(null,'medium',withPreferred),{code:'invalid_selection'},'A present preferred model restricts efforts to its own catalog entry');
 const russian=require('../package.nls.ru.json');
 assert.match(russian['view.mcpTasks'],/[А-Яа-я]/);assert(!russian['command.mcpConnectPool'].includes('?'));
 assert(!JSON.stringify(state).includes('syntheticPrivateField'));assert(!JSON.stringify(state).includes('synthetic-private-revision'));assert(!JSON.stringify(state).includes('synthetic-private-operation'));
 console.log('MCP panel: installed companion discovery and minimal task projection passed.');
})().catch(()=>{console.error('MCP panel synthetic checks failed.');process.exitCode=1;});
