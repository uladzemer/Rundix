// Isolated Extension Host fixture for authentic VS Code window captures.
// All conversation content and transport replies are synthetic. No model runs.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const {AppServer} = require('../../runtime/transport.cjs');

exports.run = async () => {
  const control = process.env.RUNDIX_DEMO_CONTROL;
  if (!control || !process.env.RUNDIX_DEMO_PROFILE) throw Error('Use workbench-demo.ps1.');
  const status = control.replace(/\.json$/, '-status.json');
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const original = {start:AppServer.prototype.start,request:AppServer.prototype.request,fetch:globalThis.fetch};
  const writeStatus = value => fs.writeFileSync(status,JSON.stringify(value));
  let timer;
  const config = vscode.workspace.getConfiguration('rundix');
  try {
    process.env.CODEX_HOME = path.join(process.env.RUNDIX_DEMO_PROFILE,'empty-cli-home');
    fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
    const cli = path.join(process.env.CODEX_HOME,'synthetic-cli.exe');
    fs.writeFileSync(cli,'Synthetic non-executable fixture');
    await config.update('cliPath',cli,vscode.ConfigurationTarget.Global);
    await config.update('cliAutoUpdate',false,vscode.ConfigurationTarget.Global);
    await config.update('showSessionsView',true,vscode.ConfigurationTarget.Global);
    await config.update('language','en',vscode.ConfigurationTarget.Global);
    globalThis.fetch = async () => {throw Error('Network is disabled in the synthetic demo.');};
    AppServer.prototype.start = async function() {return this;};
    AppServer.prototype.request = async function(method) {
      if(method==='account/read') return {account:{type:'chatgpt',email:'demo@example.test'}};
      if(method==='account/rateLimits/read') return {rateLimits:{primary:{usedPercent:24,windowDurationMins:300,resetsAt:Date.now()/1000+3600}}};
      if(method==='model/list') return {data:[{model:'demo-model',displayName:'Codex',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:['low','medium','high'].map(reasoningEffort=>({reasoningEffort}))}],nextCursor:null};
      if(method==='config/read') return {config:{model:'demo-model',model_reasoning_effort:'medium'}};
      if(method==='thread/list') return {data:[],nextCursor:null};
      if(method==='thread/read') return {thread:{id:'demo-refactor',turns:[]}};
      if(method==='thread/turns/list') return {data:[],nextCursor:null};
      if(['turn/start','turn/steer','account/login/start','account/logout'].includes(method)) throw Error('Sending and sign-in are disabled in this demo.');
      return {};
    };
    const api = await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();
    await api.connect();
    const make = (key,name,items,draft='') => api.create({key,id:key,name,items:items.map(item=>item.type==='userMessage'?{...item,content:[{type:'text',text:item.text}]}:item),draft,cwd:workspace,loaded:true,model:'demo-model',effort:'medium',prefs:{ide:true,access:'workspace',showThinking:true,controlMotion:'off',activityMotion:'off'}});
    const main = make('demo-refactor','Refactor tag parsing',[
      {id:'demo-intro-user',type:'userMessage',text:'Clean up tag parsing in this project.'},
      {id:'demo-intro-answer',type:'agentMessage',text:'I will isolate the normalization rule and keep the existing public API unchanged.'},
      {id:'demo-user',type:'userMessage',text:'Extract tag normalization into a small TypeScript function. Keep it easy to test.'},
      {id:'demo-answer',type:'agentMessage',text:'### A small, predictable refactor\n\nThe function trims whitespace, drops empty tags and preserves the first occurrence.\n\n```typescript\nexport function normalizeTags(tags: string[]) {\n  const clean = tags.map(tag => tag.trim());\n  return [...new Set(clean.filter(Boolean))];\n}\n```\n\n- **Pure function:** the input stays unchanged.\n- **Reusable:** forms and imports share the same rule.\n- **Easy to test:** no UI or network dependencies.\n\nNext, cover empty values and duplicate tags.'}
    ],'Add tests for empty input and duplicate tags.');
    const tests = make('demo-tests','Add unit tests',[
      {id:'demo-test-user',type:'userMessage',text:'Which cases should the tag parser tests cover?'},
      {id:'demo-test-answer',type:'agentMessage',text:'### Cover behavior, not implementation\n\n| Input | Expected result |\n| --- | --- |\n| `[]` | `[]` |\n| `[" docs "]` | `["docs"]` |\n| `["", "  "]` | `[]` |\n| `["docs", "docs"]` | `["docs"]` |\n\n```typescript\nexpect(normalizeTags([" docs ", "docs", "api"]))\n  .toEqual(["docs", "api"]);\n```\n\nAlso check that the original array is unchanged.'}
    ],'Add the focused test cases.');
    const plan = make('demo-plan','Plan the search',[
      {id:'demo-plan-user',type:'userMessage',text:'Помоги добавить поиск по заметкам. Сначала обсудим план.'},
      {id:'demo-plan-answer',type:'agentMessage',text:'### План небольшого изменения\n\n1. Добавим поле поиска над списком заметок.\n2. Сохраним выбранную заметку при фильтрации.\n3. Проверим пустой запрос и отсутствие результатов.\n\nПеред реализацией уточним, по каким данным искать.'}
    ]);
    for (const session of [main,tests,plan]) api.store.updateMeta(session.id,{group:session===plan?'Planning':'Website'});
    await api.handle(main,{action:'preferences',focus:false});
    await vscode.commands.executeCommand('workbench.view.extension.rundix');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('notifications.clearAll');
    const source = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'src','tags.ts');
    const scenes = new Set(['overview','tests','split','queue','access','history','questions','done']);
    let revision = -1;
    let working = false;
    await new Promise((resolve,reject) => {
      const deadline = Date.now()+15*60*1000;
      timer=setInterval(async()=>{
        if(working)return;
        working=true;
        try {
          if(Date.now()>deadline)throw Error('Demo capture timed out.');
          const request=JSON.parse(fs.readFileSync(control,'utf8').replace(/^\uFEFF/,''));
          if(request.revision===revision)return;
          if(!scenes.has(request.scene))throw Error('Unknown demo scene.');
          revision=request.revision;
          if(request.scene==='done'){writeStatus({scene:'done',revision});resolve();return;}
          await vscode.workspace.getConfiguration('workbench').update('colorTheme',request.scene==='questions'?'Default Light Modern':'Default Dark Modern',vscode.ConfigurationTarget.Global);
          await config.update('language',request.scene==='questions'?'ru':'en',vscode.ConfigurationTarget.Global);
          if(request.scene==='split') {
            await vscode.window.showTextDocument(source,{viewColumn:vscode.ViewColumn.One,preview:false});
            main.panel.reveal(vscode.ViewColumn.Two);
          } else {
            await vscode.commands.executeCommand('workbench.action.joinAllGroups');
            api.select(request.scene==='tests'?tests:request.scene==='questions'?plan:main);
          }
          main.followUps=request.scene==='queue'?[{id:'demo-next-1',text:'Add focused unit tests',attachments:[]},{id:'demo-next-2',text:'Document the normalization rules',attachments:[]}]:[];
          main.queuePaused=request.scene==='queue';
          await api.handle(main,{action:'preferences',focus:false});
          if(request.scene==='questions') {
            api.select(plan);
            api.server().emit('request',{id:'demo-question',method:'item/tool/requestUserInput',params:{threadId:plan.id,questions:[{id:'search',header:'Поиск',question:'По каким данным искать заметки?',options:[{label:'Только заголовки (Рекомендую)',description:'Простое изменение без обработки текста заметок.'},{label:'Заголовки и текст',description:'Более широкий поиск по содержимому.'}]}]}});
          }
          if(['access','history'].includes(request.scene)) await main.panel.webview.postMessage({type:'open',action:request.scene});
          // Allow actual workbench/webview rendering to settle before native capture.
          await new Promise(done=>setTimeout(done,1200));
          writeStatus({ready:true,scene:request.scene,revision,synthetic:true,inferencePerformed:false});
        }catch(error){writeStatus({error:true});reject(error);}
        finally{working=false;}
      },250);
    });
  } finally {
    clearInterval(timer);
    Object.assign(AppServer.prototype,{start:original.start,request:original.request});
    globalThis.fetch=original.fetch;
  }
};
