const locale = require("./ui/i18n.js");
// Independent implementation using the documented Codex App Server protocol.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");
const { AppServer, findCli } = require("./runtime/transport.cjs");
const { CliUpdates } = require('./runtime/cli-updates.cjs');
const { savePastedImage } = require('./runtime/pasted-image.cjs');
const { messageImages } = require('./runtime/message-images.cjs');
const { readCatalog } = require('./runtime/model-catalog.cjs');
const {
  notification,
  itemText,
  readItem,
  copyText,
} = require("./runtime/session.cjs");
const { SessionLibrary } = require("./runtime/library.cjs");
const { newSessionSettings } = require('./runtime/new-session-settings.cjs');
const { canEditQueued, queuedEdit, selectedAttachments, assertQueueCurrent, moveQueued } = require('./runtime/queued-edits.cjs');
const { fileAttachment, stageQueuedAttachments } = require('./runtime/queued-attachments.cjs');
const { transferQueuedSession, acquireQueuedSession } = require('./runtime/queued-session-transfer.cjs');
const { SessionStore } = require("./runtime/store.cjs");
const {PendingLogin} = require('./runtime/pending-login.cjs');
const { startLogin, identity } = require("./runtime/account.cjs");
const { Connections } = require('./runtime/connections.cjs');
const taskDirectory = require('./runtime/task-directory.cjs');
const { McpTasks } = require('./runtime/mcp-tasks.cjs');
const mcpBridgeTransport = require('./runtime/mcp-bridge.cjs');
const { executor: mcpExecutor, reportMarkdown: mcpReportMarkdown } = require('./runtime/mcp-executor.cjs');
const {activateCompanions}=require('./runtime/connection-companions.cjs');
const mcpPanelState=require('./runtime/mcp-panel.cjs');
const { ProjectFiles } = require("./runtime/files.cjs");
const modes = require("./ui/modes.js");
const speed = require('./ui/speed.js');
const { buildInput } = require("./runtime/input.cjs");
const { versions } = require("./runtime/diff.cjs");
const forms = require("./ui/forms.js");
const asyncQuestions = require('./runtime/async-questions.cjs');
const questionRecords = require('./runtime/question-records.cjs');
const preflight = require('./runtime/task-preflight.cjs');
const { reference } = require("./runtime/references.cjs");
const { tabTitle } = require("./runtime/titles.cjs");
const { CompletionNotifications, capture: captureCompletion } = require('./runtime/completion-notifications.cjs');
const { NotificationSettings } = require('./runtime/notification-settings.cjs');
function activate(context) {
  const languageChoice = () =>
    vscode.workspace.getConfiguration("rundix").get("language", "auto");
  locale.setLanguage(locale.resolve(languageChoice(), vscode.env.language));
  const output = vscode.window.createOutputChannel("Rundix");
  context.subscriptions.push(output);
  const completionNotifications = new CompletionNotifications({ state: context.globalState, secrets: context.secrets,
    diagnostic: category => output.appendLine('[completion notification] ' + category),
    trusted: () => vscode.workspace.isTrusted });
  const notificationSettings = new NotificationSettings(vscode, completionNotifications);
  context.subscriptions.push(completionNotifications);
  const sessions = new Map(),
    hosts = new Map();
  let lastHost,
    loginId,
    server,
    connecting,
    catalog = [],
    account,
    limits = { buckets: [], loading: false, updatedAt: null, error: false },
    limitsEpoch = 0,
    limitsRequest = null,
    defaultModel,
    defaultEffort,
    lastEditor = vscode.window.activeTextEditor;
  let authBusy = false, authOwner = null;
  const pendingLogin = new PendingLogin({timeout: 5 * 60 * 1000, onFinish: (error, record) => {
    loginId = null;
    if (authOwner === record.release) { authOwner = null; authBusy = false; }
    if (record.disposed && server === record.client) {
      server = null; connecting = null; activeConnection = null;
      account = null; catalog = []; catalogUpdatedAt = 0;
    }
    if (error && target()) target().error = error;
    broadcast();
  }});
  const pastedImageRoot=path.join(context.globalStorageUri.fsPath,'pasted-images');
  const cliUpdates = new CliUpdates({root:path.join(context.globalStorageUri.fsPath,'cli')});
  let cliOverride = null, cliPrepared = null, cliCheckRequest = null, disposed = false;
  let cliInfo = {version:null,phase:'idle',error:false,managed:false};
  let catalogRequest = null, catalogUpdatedAt = 0, accountReadRevision = 0, accountRequestEpoch = 0;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if(event.affectsConfiguration('rundix.chatWidth') ||
        event.affectsConfiguration('rundix.contextDisplay') ||
        event.affectsConfiguration('rundix.controlMotion') ||
        event.affectsConfiguration('rundix.activityMotion'))broadcast();
      if(event.affectsConfiguration('rundix.cliChannel') || event.affectsConfiguration('rundix.cliAutoUpdate')) {
        broadcast();
        if(event.affectsConfiguration('rundix.cliChannel'))void checkCliUpdates(true);
        else if(vscode.workspace.getConfiguration('rundix').get('cliAutoUpdate',true))void checkCliUpdates();
      }
      if (!event.affectsConfiguration("rundix.language")) return;
      locale.setLanguage(locale.resolve(languageChoice(), vscode.env.language));
      for (const host of hosts.values())
        if (host.panel) host.panel.webview.html = html(host.panel.webview);
    }),
  );
  const store = new SessionStore(
    path.join(context.globalStorageUri.fsPath, "sessions-v1"),
  );
  const connections = new Connections({store, activateOwner: async owner => {
    const extension = vscode.extensions.getExtension(owner);
    if (!extension) throw Error('The selected connection extension is not installed.');
    await extension.activate();
  }});
  let activeConnection = null, connectionStarting = false;
  const providerClients = new WeakMap();
  function providerClient(client, connection) {
    if (!providerClients.has(client)) {
      const assertOwner = () => {
        connections.assertCurrent(connection);
        if (server !== client) throw Error('The connection client has closed.');
      };
      providerClients.set(client, {
        async request(...args) { assertOwner(); const result = await client.request(...args); assertOwner(); return result; },
        respond(...args) { assertOwner(); return client.respond(...args); },
      });
    }
    return providerClients.get(client);
  }
  let accountStatusRequest = null;
  const turnLeases = new Map();
  for (const key of context.workspaceState
    .keys()
    .filter((key) => key.startsWith("session:"))) {
    const old = context.workspaceState.get(key);
    if (old?.key && !store.session(old.key))
      store.saveSession({
        ...old,
        cwd: old.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      });
  }
  const library = new SessionLibrary(context.workspaceState, store);
  for (const [id, meta] of Object.entries(library.meta))
    if (!Object.keys(store.meta(id)).length) store.updateMeta(id, meta);
  let recent = [],
    historyLoaded = false,
    reopenQueue = Promise.resolve();
  const treeEvents = new vscode.EventEmitter();
  context.subscriptions.push(treeEvents);
  void vscode.commands.executeCommand(
    "setContext",
    "rundix.hasClosed",
    library.closed.length > 0,
  );
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      if (event.closed?.length)
        void vscode.commands.executeCommand(
          "setContext",
          "rundix.hasClosed",
          event.closed.at(-1).input?.viewType === "rundix.session" &&
            library.closed.length > 0,
        );
    }),
  );
  const pendingRequests = new Map();
  const threadReleases = new Map();
  let mcpTasks=null, mcpBridge=null, mcpLease=null, mcpStarting=null, mcpLauncher=null;
  const mcpViews=new Map();
  let mcpEditor=null, mcpPanelBusy=false;
  const mcpRecords=()=>mcpTasks?[...mcpTasks.tasks.values()]:mcpPanelState.readRecords(path.join(context.globalStorageUri.fsPath,'mcp','tasks'));
  async function connectMcpPool() {
    if(!vscode.workspace.isTrusted)throw Error('Workspace trust is required.');
    if(connections.selection().id==='local') {
      await activateCompanions(vscode.extensions,'local-rundix-tools.rundix');
      const choices=connections.choices().filter(choice=>choice.id!=='local');
      const choice=choices.length===1?choices[0]:await vscode.window.showQuickPick(choices.map(c=>({label:c.label,id:c.id})),{title:locale.t('Подключить рабочий пул')});
      if(!choice)throw Error('An installed companion connection is required.');
      await configureConnection(choice.id);
    }
    if(connections.selection().id==='local')throw Error('Select a companion connection.');
    await connections.resolve();
    await refreshAccountStatus();
    if(!account || limits.error)throw Error('The selected pool connection is unavailable.');
  }
  function mcpPanelSnapshot() {
    let connected=false;
    try{if(activeConnection?.provider && account && !limits.error){connections.assertCurrent(activeConnection);connected=true;}}catch{}
    return mcpPanelState.snapshot({records:mcpRecords(),language:locale.language,connection:connections.display(),connected,bridgeRunning:!!mcpBridge,
      pending:task=>mcpTasks?.adapter.pending(task) || []});
  }
  function publishMcpPanel(force=false) {
    if(![...mcpViews.keys()].some(view=>view.visible))return;
    try {
      const data=mcpPanelSnapshot(), signature=JSON.stringify(data);
      for(const [view,record]of mcpViews)if(view.visible && (force || signature!==record.signature)){
        record.signature=signature;void view.webview.postMessage({type:'mcpState',data});
      }
    }catch{for(const view of mcpViews.keys())if(view.visible)void view.webview.postMessage({type:'mcpResult',ok:false});}
  }
  function mcpConfiguration() {
    if(!mcpBridge)throw Error('Start the MCP bridge first.');
    return {mcpServers:{rundix:{command:'node',args:[mcpLauncher,'--bridge',mcpBridge.descriptor]}}};
  }
  async function handleMcpPanel(message) {
    if(!message || typeof message.action!=='string')throw Error('Invalid MCP panel action.');
    if(message.action==='ready' || message.action==='refresh'){publishMcpPanel(true);return;}
    if(message.action==='connectPool')await connectMcpPool();
    else if(message.action==='start'){await connectMcpPool();await startMcp();}
    else if(message.action==='stop')await stopMcp();
    else if(message.action==='configuration' || message.action==='copyConfiguration') {
      const configuration=mcpConfiguration();
      if(message.action==='copyConfiguration')await vscode.env.clipboard.writeText(JSON.stringify(configuration,null,2));
      return {configuration};
    }
    else if(['openChat','cancel','continue'].includes(message.action)) {
      const task=mcpRecords().find(task=>task.taskId===message.taskId);
      if(!task)throw Error('Unknown taskId');
      if(message.action==='openChat') {
        const saved=store.session(task.sessionKey), existing=sessions.get(task.sessionKey);
        if(!saved || !task.chatId || saved.id!==task.chatId)throw Error('Task chat metadata is unavailable.');
        if(existing?.panel)select(existing);else create(saved);
      }else {
        if(!mcpTasks || !vscode.workspace.isTrusted)throw Error('Start the MCP bridge in a trusted workspace.');
        if(typeof message.requestId!=='string' || !/^[\w-]{1,128}$/.test(message.requestId))throw Error('Invalid panel requestId.');
        await mcpTasks.call(message.action==='cancel'?'cancel_task':'continue_task',{
          taskId:task.taskId,requestId:message.requestId,...(message.action==='continue'?{clarification:message.clarification}:{})});
      }
    }else throw Error('Unknown MCP panel action.');
    publishMcpPanel(true);
  }
  function attachMcpView(view,onVisible) {
      mcpViews.set(view,{signature:''});
      view.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'ui')]};
      const nonce=randomBytes(18).toString('base64'), uri=file=>view.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'ui',file));
      view.webview.html=`<!doctype html><html lang="${locale.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${uri('mcp-panel.css')}"></head><body><main id="app"></main><script nonce="${nonce}" src="${uri('mcp-panel.js')}"></script></body></html>`;
      const listener=view.webview.onDidReceiveMessage(async message=>{
        if(mcpPanelBusy){await view.webview.postMessage({type:'mcpResult',ok:false,requestId:message?.requestId});return;}
        mcpPanelBusy=true;
        try{const result=await handleMcpPanel(message);await view.webview.postMessage({type:'mcpResult',ok:true,action:message.action,taskId:message.taskId,requestId:message.requestId,...result});}
        catch(error){try{await view.webview.postMessage({type:'mcpResult',ok:false,requestId:message?.requestId,
          ...(typeof error?.code==='string' && /^[a-z_]{1,40}$/.test(error.code) && typeof error.message==='string'?{error:error.message.slice(0,300)}:{})});}catch{}}
        finally{mcpPanelBusy=false;}
      });
      const visible=onVisible(()=>publishMcpPanel(true));
      view.onDidDispose(()=>{listener.dispose();visible.dispose();mcpViews.delete(view);if(mcpEditor===view)mcpEditor=null;});
  }
  function openMcpEditor() {
    if(mcpEditor){mcpEditor.reveal();publishMcpPanel(true);return mcpEditor;}
    mcpEditor=vscode.window.createWebviewPanel('rundix.mcp','Rundix · MCP',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'ui')]});
    mcpEditor.iconPath=vscode.Uri.joinPath(context.extensionUri,'resources','extension-icon.png');
    attachMcpView(mcpEditor,listener=>mcpEditor.onDidChangeViewState(listener));
    return mcpEditor;
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('rundix.mcpTasks',{
    resolveWebviewView(view) {attachMcpView(view,listener=>view.onDidChangeVisibility(listener));},
  }),vscode.commands.registerCommand('rundix.mcpPanel',openMcpEditor),
  vscode.commands.registerCommand('rundix.mcpConnectPool',connectMcpPool),
  vscode.window.registerWebviewPanelSerializer('rundix.mcp',{
    async deserializeWebviewPanel(panel){
      if(mcpEditor && mcpEditor!==panel){panel.dispose();return;}
      mcpEditor=panel;attachMcpView(panel,listener=>panel.onDidChangeViewState(listener));
    },
  }));
  const mcpPanelTimer=setInterval(()=>publishMcpPanel(),1000);
  context.subscriptions.push({dispose(){clearInterval(mcpPanelTimer);}});
  async function startMcp() {
    if(mcpStarting)return mcpStarting;
    if(mcpBridge)return mcpBridge.descriptor;
    mcpStarting=(async()=>{
      if(!vscode.workspace.isTrusted)throw Error('Trust the VS Code workspace before starting MCP.');
      mcpLease=store.acquire('mcp-bridge');
      try {
        const root=path.join(context.globalStorageUri.fsPath,'mcp');
        mcpBridgeTransport.privateDirectory(root);
        // A locked launcher copy must not keep the bridge down; the packaged server still works until the next start.
        try{mcpLauncher=mcpBridgeTransport.installLauncher(root,context.extension.packageJSON.version);}
        catch{mcpLauncher=path.join(context.extensionUri.fsPath,'runtime','mcp-server.cjs');}
        mcpTasks=new McpTasks({store:new SessionStore(path.join(root,'tasks')),directoryStore:store,
          maxParallel:()=>vscode.workspace.getConfiguration('rundix').inspect('mcpMaxParallelTasks')?.globalValue ?? 3,
          adapter:mcpExecutor({connections,sessions,store,create,
            send,
            resume,handle,pending:pendingRequests,save,alive:()=>!disposed && !!mcpBridge,
            closeTab,
            // Only a restored tab that hosts exactly this chat and is unambiguous by title is closed.
            async closeSavedTab(key){
              const saved=store.session(key);
              if(!saved?.name)return false;
              const hosts=fs.readdirSync(store.directory).filter(name=>/^host-[\w-]+\.json$/.test(name)).map(name=>store.host(name.slice(5,-5))).filter(host=>host?.keys?.includes(key));
              if(hosts.length!==1 || hosts[0].keys.length!==1)return false;
              const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>tab.input instanceof vscode.TabInputWebview &&
                String(tab.input.viewType).includes('rundix.session') && tab.label===tabTitle(saved.name));
              if(tabs.length!==1)return false;
              return vscode.window.tabGroups.close(tabs[0]);
            },
            // Lets the agent client apply an installed update itself; busy chats are protected unless forced.
            reloadWindow(force){
              if(!force && [...sessions.values()].some(s=>s.busy || s.sendingTask || s.compacting))
                throw Object.assign(Error('A Rundix chat is still working; wait for it, or pass force:true.'),{code:'task_active'});
              setTimeout(()=>{void vscode.commands.executeCommand('workbench.action.reloadWindow');},300);
            },
            async models(){
              // Load the catalog within the bridge's request budget; an empty answer must mean "no models", never "not loaded".
              if(!catalog.length){
                let timer;
                const load=(async()=>{await connect();await refreshCatalog();})();
                try{await Promise.race([load,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),9000);})]);}
                catch{throw Object.assign(Error('The model catalog is not available yet. Check the Codex connection in Rundix and retry.'),{code:'connection_unavailable'});}
                finally{clearTimeout(timer);load.catch(()=>{});}
              }
              return catalog.map(model=>({model:model.model,displayName:model.displayName || model.model,isDefault:!!model.isDefault,
                defaultEffort:model.defaultReasoningEffort || null,efforts:(model.supportedReasoningEfforts || []).map(effort=>effort.reasoningEffort).filter(Boolean)}));
            },
            releases:threadReleases,client:()=>{if(!activeConnection || !server)return null;connections.assertCurrent(activeConnection);return server;},
            // Only the user's own settings count: a repository's workspace settings must not grant MCP full access.
            accessMode:()=>vscode.workspace.getConfiguration('rundix').inspect('mcpAccessMode')?.globalValue || 'workspace',
            async sent(s,text){
              publish(s,true);
              await s.panel?.webview.postMessage({type:'sent',key:s.key,text});
            },
            retainTurn(s,task){
              if(turnLeases.has(s.id))return;
              const unlockDirectory=taskDirectory.acquire(store,s.cwd,task.taskId);
              let unlockSession;
              try{unlockSession=store.acquire(s.id);}catch(error){unlockDirectory();throw error;}
              turnLeases.set(s.id,()=>{unlockSession();unlockDirectory();});
            }})});
        mcpBridge=await mcpBridgeTransport.serve({directory:root,call:(name,args)=>{
          if(!vscode.workspace.isTrusted)throw Object.assign(Error('Trust the VS Code workspace that runs the Rundix MCP bridge.'),{code:'workspace_untrusted'});
          return mcpTasks.call(name,args);
        }});
        mcpTasks.schedule();
        await context.globalState.update('mcpEnabled',true);
        broadcast();
        return mcpBridge.descriptor;
      }catch(error){mcpTasks?.dispose();mcpTasks=null;mcpBridge?.dispose();mcpBridge=null;mcpLease?.();mcpLease=null;throw error;}
    })();
    try{return await mcpStarting;}finally{mcpStarting=null;}
  }
  async function stopMcp() {
    if(mcpStarting)await mcpStarting;
    if(mcpTasks && [...mcpTasks.tasks.values()].some(t=>['running','waiting_approval'].includes(t.state)))throw Error('Cancel active MCP tasks and wait for confirmation before stopping the bridge.');
    mcpTasks?.dispose();mcpTasks=null;mcpBridge?.dispose();mcpBridge=null;mcpLease?.();mcpLease=null;
    await context.globalState.update('mcpEnabled',false);
    broadcast();
  }
  context.subscriptions.push(vscode.commands.registerCommand('rundix.mcpStart',async()=>{
    await connectMcpPool();
    const descriptor=await startMcp();
    const config=mcpConfiguration();
    const document=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(config,null,2)});
    await vscode.window.showTextDocument(document);
    return descriptor;
  }),vscode.commands.registerCommand('rundix.mcpStop',stopMcp));
  if(context.globalState.get('mcpEnabled',false))void startMcp().catch(()=>{});
  let nextDraft = 1;
  const virtualDocuments = new Map();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "rundix-diff",
      {
        provideTextDocumentContent: (uri) =>
          virtualDocuments.get(uri.toString()) || "",
      },
    ),
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === "rundix-diff")
        virtualDocuments.delete(document.uri.toString());
    }),
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) lastEditor = editor;
    }),
  );
  const cwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const projectFiles = new ProjectFiles(async (root) =>
    (
      await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, "**/*"),
        "**/{.git,node_modules,dist,build,out,.next,.venv,venv}/**",
        10000,
      )
    ).map((uri) => uri.fsPath),
  );
  for (const event of [
    vscode.workspace.onDidCreateFiles,
    vscode.workspace.onDidDeleteFiles,
    vscode.workspace.onDidRenameFiles,
  ])
    context.subscriptions.push(event(() => projectFiles.clear()));
  const isActive = (s) => !!s.panel?.active && s.host?.activeKey === s.key;
  function broadcast() {
    for (const s of sessions.values()) publish(s);
    treeEvents.fire();
  }
  function tabRows(host) {
    return host.keys
      .map((key) => sessions.get(key))
      .filter(Boolean)
      .map((s) => ({
        key: s.key,
        name: s.name,
        cwd: s.cwd,
        parentId: s.parentId,
        busy: s.busy,
        unread: !!library.get(s).unread,
        pending: [...pendingRequests.values()].some(
          (r) => r.params?.threadId === s.id,
        ),
      }));
  }
  function publish(s, immediate = false) {
    const host = s.host;
    if (!host?.panel) return;
    if (host.timer) {
      if (!immediate) return;
      clearTimeout(host.timer);
    }
    const sendState = () => {
      host.timer = null;
      const active = sessions.get(host.activeKey);
      if (!host.panel || !active) return;
      const s = active,
        meta = library.get(s);
      host.panel.title = tabTitle(s.name);
      void host.panel.webview.postMessage({
        type: "state",
        data: {
          language: locale.language,
          languageChoice: languageChoice(),
          historyScope: vscode.workspace.getConfiguration("rundix").get("historyScope", "workspace"),
          hostKey: host.key,
          tabs: tabRows(host),
          key: s.key,
          id: s.id,
          name: s.name,
          cwd: s.cwd || null,
          parentId: s.parentId || null,
          model: s.model,
          effort: s.effort,
          models: catalog,
          cli: {...cliInfo, channel:cliChannel(),autoUpdate:vscode.workspace.getConfiguration('rundix').get('cliAutoUpdate',true),custom:!!configuredCliPath()},
          modelsUpdatedAt: catalogUpdatedAt,
          account: connections.projectAccount(account),
          connection: connections.display(),
          mcpBridgeRunning:!!mcpBridge,
          authBusy,
          chatWidth:vscode.workspace.getConfiguration('rundix').get('chatWidth','wide'),
          contextDisplay:vscode.workspace.getConfiguration('rundix').get('contextDisplay','percent'),
          controlMotion:vscode.workspace.getConfiguration('rundix').get('controlMotion','auto'),
          activityMotion:vscode.workspace.getConfiguration('rundix').get('activityMotion','auto'),
          limits,
          loginPending: !!loginId,
          busy: s.busy,
          turnId:s.turnId || null,
          turnStartedAt:s.turnStartedAt || null,
          compacting: !!s.compacting,
          asyncQuestionReplies:s.asyncQuestionReplies || {},
          asyncQuestionSending:s.asyncQuestionSending || null,
          questionHistory:s.questionHistory || [],
          preflight:s.preflight || null,
          tokenUsage: s.tokenUsage || null,
          usageModel: s.usageModel || null,
          usageStale: !!s.usageStale,
          error: s.error || null,
          prefs: s.prefs,
          defaults: library.defaults,
          bookmarks: library
            .bookmarks(s)
            .map(({ id, turnId, title, createdAt }) => ({
              id,
              turnId,
              title,
              createdAt,
            })),
          group: meta.group || "",
          unread: !!meta.unread,
          draft: s.draft || "",
          attachments: s.attachments.map(file=>({...file,...(file.pasted?{preview:host.panel.webview.asWebviewUri(vscode.Uri.file(file.path)).toString()}:{} )})),
          followUps:(s.followUps || []).map(item=>({id:item.id,text:item.text,model:item.modelSelection?.model,editable:canEditQueued(item),deliveryUncertain:!!item.deliveryUncertain,transferPending:!!item.transferToSession,attachments:item.attachments.map(file=>({id:file.id,name:file.name || path.basename(file.path || ''),kind:file.kind})),images:item.attachments.filter(file=>file.kind==='image').length})),
          queuePaused: !!s.queuePaused,
          followUpSending:!!s.followUpSending,
          hasOlder: !!s.cursor,
          items: s.items.map((item) => ({
            id: item.id,
            type: item.type,
            text: s.preflight?.enabled&&item.type==='agentMessage'?preflight.display(itemText(item)):(s.mcpTask&&item.type==='agentMessage'&&mcpReportMarkdown(itemText(item),locale.language))||itemText(item),
            // The webview sees display text, so the host decides from raw items whether a quiz was answered.
            ...(item.type==='agentMessage' && asyncQuestions.questions(item).length ? {asyncAnswered:asyncQuestions.hasReply(s.items,item.id)} : {}),
            images:messageImages(item,pastedImageRoot,file=>host.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString()),
            status: item.status,
            turnId: item.turnId,
            phase: item.phase,
            questions:asyncQuestions.questions(item).length ? item.questions : undefined,
            timestamp: item.timestamp,
            exitCode: item.exitCode,
            durationMs: item.durationMs,
            command: item.command,
            tool: item.tool,
            changes: item.type === "fileChange" ? item.changes : undefined,
          })),
          requests: [...pendingRequests.values()]
            .filter(
              (r) =>
                r.params?.threadId === s.id ||
                (!r.params?.threadId && isActive(s)),
            )
            .map((r) => ({ id: r.id, method: r.method, params: r.params })),
        },
      });
    };
    if (immediate) sendState();
    else host.timer = setTimeout(sendState, 40);
  }
  function cliChannel() {
    return vscode.workspace.getConfiguration('rundix').get('cliChannel','stable') === 'alpha' ? 'alpha' : 'stable';
  }
  function configuredCliPath() {
    return vscode.workspace.getConfiguration('rundix').inspect('cliPath')?.globalValue || '';
  }
  async function resolveCli() {
    const configured=configuredCliPath();
    let executable;
    if(configured) {executable=findCli(configured);cliInfo.managed=false;}
    else if(cliOverride)executable=cliOverride;
    else {
      const current=cliUpdates.current(cliChannel());
      if(current){executable=current.executable;cliInfo={...cliInfo,version:current.version,managed:true};}
      else try {executable=findCli();}catch{}
    }
    if(!executable) {
      const preparedChannel=cliChannel();
      cliPrepared=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,
        title:locale.t('Подготовка Codex CLI'),cancellable:false},progress=>cliUpdates.prepare(preparedChannel,{
          onProgress:message=>progress.report({message}),
        }));
      cliPrepared.channel=preparedChannel;
      executable=cliPrepared.executable;cliInfo={...cliInfo,version:cliPrepared.version,managed:true};
    }
    if(!cliInfo.version || configured || (!cliInfo.managed && !cliOverride)) {
      try {
        const result=await require('node:util').promisify(require('node:child_process').execFile)(executable,['--version'],{windowsHide:true,timeout:15000,maxBuffer:65536});
        cliInfo.version=result.stdout.trim().match(/^codex-cli ([\w.-]+)$/)?.[1] || null;
      }catch{cliInfo.version=null;}
    }
    return executable;
  }
  async function checkCliUpdates(force=false) {
    if(cliCheckRequest)return cliCheckRequest;
    const config=vscode.workspace.getConfiguration('rundix');
    if(disposed || configuredCliPath() || (!force && !config.get('cliAutoUpdate',true)))return;
    const channel=cliChannel();
    cliCheckRequest=(async()=>{
      cliInfo={...cliInfo,phase:'checking',error:false};broadcast();
      const candidate=await cliUpdates.prepare(channel,{force,onProgress:()=>{cliInfo.phase='downloading';broadcast();}});
      if(disposed||channel!==cliChannel())return;
      if(configuredCliPath() || (!force&&!vscode.workspace.getConfiguration('rundix').get('cliAutoUpdate',true))){cliInfo.phase='idle';return;}
      cliInfo.checkedAt=Date.now();
      if(server?.executable===candidate.executable){cliUpdates.accept(channel,candidate);cliInfo={...cliInfo,version:candidate.version,managed:true,phase:'ready'};await refreshCatalog();return;}
      if(authBusy||loginId||accountStatusRequest||pendingRequests.size||[...sessions.values()].some(s=>s.busy||s.compacting)) {cliInfo.phase='pending';return;}
      let release;
      try {release=store.acquire('account-credentials');store.assertNoActiveTurns();}
      catch {release?.();cliInfo.phase='pending';return;}
      const previous={executable:server?.executable,info:{...cliInfo}};
      authBusy=true;cliInfo.phase='applying';broadcast();
      try {
        for(const s of sessions.values())await save(s);
        stopAccountServer();
        for(const s of sessions.values())s.loaded=false;
        cliOverride=candidate.executable;
        await connect();
        cliUpdates.accept(channel,candidate);
        cliInfo={version:candidate.version,managed:true,phase:'ready',error:false,checkedAt:Date.now()};
      }catch {
        cliUpdates.reject(channel,candidate);
        stopAccountServer();cliOverride=previous.executable;
        if(previous.executable)try{await connect();}catch{}
        cliInfo={...previous.info,phase:'error',error:true};
      }finally{authBusy=false;release();}
    })().catch(()=>{cliInfo={...cliInfo,phase:'error',error:true};}).finally(()=>{cliCheckRequest=null;broadcast();if(!disposed&&channel!==cliChannel())void checkCliUpdates(true);});
    return cliCheckRequest;
  }
  async function connect() {
    if (connecting) {
      if (activeConnection) connections.assertCurrent(activeConnection);
      return connecting;
    }
    connectionStarting = true;
    connecting = (async () => {
      activeConnection = await connections.resolve();
      if (cwd()) fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
      server = new AppServer({
        executable: path.resolve(await resolveCli()),
        // The shared server outlives turns. Its Windows cwd must not pin a worktree.
        // Chat/project directories are supplied by thread/start and turn/start.
        cwd: cwd() ? context.globalStorageUri.fsPath : undefined,
        configArgs:['-c','features.default_mode_request_user_input=true'],
      });
      const notificationServer=server;
      server.on("notification", (message) => {
        if(server!==notificationServer)return;
        if (message.method === "account/rateLimits/updated") {
          const update = require("./ui/limits.js").normalize(message.params);
          if (update.length) {
            const merged = new Map(limits.buckets.map((b) => [b.id, b]));
            for (const bucket of update) merged.set(bucket.id, bucket);
            limits = {
              buckets: [...merged.values()],
              loading: false,
              updatedAt: Date.now(),
              error: false,
            };
            broadcast();
          }
          return;
        }
        if (message.method === "serverRequest/resolved") {
          pendingRequests.delete(String(message.params.requestId));
          broadcast();
          return;
        }
        if (message.method === "account/login/completed") {
          const pending = pendingLogin.current;
          if (pending?.client === notificationServer && !pending.id) {
            // A response and its notification may share a transport chunk;
            // login/start's await continuation has not assigned the ID yet.
            (pending.completions ||= []).push(message);
            return;
          }
          if (!pendingLogin.complete(notificationServer, message.params.loginId)) return;
          if (!message.params.success) {
            const active = target();
            if (active)
              active.error = message.params.error || "Login cancelled";
            broadcast();
          }
        }
        if (
          message.method === "account/updated" ||
          message.method === "account/login/completed"
        ) {
          limitsEpoch++;
          limitsRequest = null;
          limits = {
            buckets: [],
            loading: false,
            updatedAt: null,
            error: false,
          };
          broadcast();
          void refreshAccount()
            .then(() => refreshLimits())
            .then(() => refreshCatalog())
            .then(async () => {
              if (
                message.method === "account/login/completed" &&
                message.params.success
              ) {
                const active = target();
                if (active?.panel) void loadSelected(active);
              }
            })
            .catch((error) => {
              const active = target();
              if (active) {
                active.error = error.message;
                publish(active);
              }
            });
        }
        if (
          message.method === "item/completed" &&
          message.params?.item?.type === "fileChange"
        )
          projectFiles.clear();
        for (const s of sessions.values()) {
          const completion = captureCompletion(s, message);
          // A duplicate/stale completion must not approve a different preparation turn.
          if(s.preflight?.enabled && message.method==='turn/completed' && message.params?.turn?.id!==s.turnId)continue;
          if (notification(s, message)) {
            if(message.method==='item/completed' && message.params?.item?.type==='userMessage'){
              questionRecords.restore(s);
            }
            if (message.method === "turn/completed") {
              completionNotifications.dispatch(completion);
              if(s.preflight?.enabled)
                preflight.finish(s.preflight,s.items,message.params.turn.id,message.params.turn.status,hasPendingQuestions(s));
              turnLeases.get(s.id)?.();
              turnLeases.delete(s.id);
              s.lastTurnStatus=message.params.turn.status;
              void save(s);
              void applyPendingMode(s).catch(error=>{s.error=error.message;publish(s);});
              if(s.lastTurnStatus==='completed' && !s.stopRequested)void drainFollowUps(s).catch(error=>{s.error=error.message;publish(s);});
              if (!isActive(s))
                void library.update(s, { unread: true }).then(broadcast);
            }
            publish(s);
            if (!s.panel && !s.busy) sessions.delete(s.key);
          }
        }
        treeEvents.fire();
      });
      server.on("request", (request) => {
        const provider = activeConnection?.provider;
        if (provider?.requestMethods?.includes(request.method)) {
          const owner = activeConnection, client = server;
          void Promise.resolve().then(() => {
            connections.assertCurrent(owner);
            return provider.handleRequest(providerClient(client, owner), request);
          }).catch(() => {
            if (server === client) client.respond(request.id, null, {code:-32000,message:'Connection authorization is unavailable. Retry after reconnecting.'});
          });
          return;
        }
        const owner=[...sessions.values()].find(s=>s.id===request.params?.threadId);
        if(preflight.preparing(owner?.preflight) && request.method!=='item/tool/requestUserInput'){
          server.respond(request.id,null,{code:-32600,message:'Task preparation does not grant tool approvals.'});
          return;
        }
        const known = [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/tool/requestUserInput",
          "item/permissions/requestApproval",
          "mcpServer/elicitation/request",
        ];
        if (!known.includes(request.method)) {
          server.respond(request.id, null, {
            code: -32601,
            message: "This local client does not implement " + request.method,
          });
          return;
        }
        pendingRequests.set(String(request.id), request);
        broadcast();
        if (
          ![...sessions.values()].some(
            (s) => s.id === request.params?.threadId && s.panel,
          )
        )
          void vscode.window.showWarningMessage(
            locale.t(
              "Codex ожидает ответа в другой сессии. Откройте её в Rundix.",
            ),
          );
      });
      server.on("disconnected", (message) => {
        if (server !== notificationServer) return;
        if (pendingLogin.current?.client === notificationServer) pendingLogin.finish();
        connecting = null;
        limitsEpoch++;
        limitsRequest = null;
        limits = { buckets: [], loading: false, updatedAt: null, error: true };
        pendingRequests.clear();
        for (const release of turnLeases.values()) release();
        turnLeases.clear();
        for (const s of sessions.values()) {
          s.loaded = false;
          s.turnId = null;
          s.busy = false;
          // A compaction cut off by the crash will never report completion.
          s.compacting = false;
          s.error = message;
          publish(s);
        }
        output.appendLine(message);
      });
      server.on("protocolError", (message) => output.appendLine(message));
      await server.start();
      if (activeConnection.provider) await activeConnection.provider.authenticate(providerClient(server, activeConnection));
      connections.assertCurrent(activeConnection);
      await refreshAccount();
      await refreshCatalog();
      if(cliPrepared && server.executable===cliPrepared.executable){cliUpdates.accept(cliPrepared.channel,cliPrepared);cliPrepared=null;}
      if(!cliCheckRequest) setTimeout(()=>{if(!disposed)void checkCliUpdates();},0);
      return server;
    })().catch((error) => {
      connecting = null;
      server?.dispose();
      throw error;
    }).finally(() => { connectionStarting = false; });
    return connecting;
  }
  async function refreshAccount() {
    const client = server, requestEpoch = ++accountRequestEpoch;
    const previous = identity(account);
    const result = await client.request("account/read", { refreshToken: false });
    if (client !== server || requestEpoch !== accountRequestEpoch) return false;
    account = result.account
      ? {
          type: result.account.type,
          email: result.account.email,
          planType: result.account.planType,
        }
      : null;
    const changed = previous !== identity(account);
    if (changed) {
      catalog=[];catalogUpdatedAt=0;
      limitsEpoch++;
      limitsRequest = null;
      limits = { buckets: [], loading: false, updatedAt: null, error: false };
      for (const s of sessions.values()) if (!s.busy) s.loaded = false;
      void refreshLimits();
    }
    broadcast();
    accountReadRevision++;
    return changed;
  }
  async function withLocalSignIn(operation) {
    if (pendingLogin.current) throw Error(browserSignInMessage());
    if (authBusy || connectionStarting || accountStatusRequest || [...sessions.values()].some(session => session.busy || session.compacting || session.sendingTask))
      throw Error(locale.t('Дождитесь завершения задач перед сменой аккаунта.'));
    const release = store.acquire('account-credentials');
    try {
      store.assertNoActiveTurns();
      authOwner = release; authBusy = true; broadcast();
      return await operation(release);
    } finally {
      if (pendingLogin.current?.release !== release) {
        if (authOwner === release) { authOwner = null; authBusy = false; }
        release();
      }
      broadcast();
    }
  }
  function browserSignInMessage(otherWindow = false) {
    return locale.language === 'en'
      ? (otherWindow ? 'Account access is busy in another window. Complete or cancel any browser sign-in from the account menu in that window, or wait for the connection change to finish.' : 'Complete or cancel the browser sign-in from the account menu before sending or changing connections.')
      : (otherWindow ? 'Аккаунт занят в другом окне. Завершите или отмените вход через браузер в меню аккаунта того окна либо дождитесь смены подключения.' : 'Завершите или отмените вход через браузер в меню аккаунта перед отправкой или сменой подключения.');
  }
  function refreshAccountStatus() {
    if (authBusy) return Promise.reject(Error('Wait for the connection change to finish.'));
    if (accountStatusRequest) return accountStatusRequest;
    accountStatusRequest = (async () => {
      await connect();
      await refreshAccount();
      await Promise.all([refreshLimits(), refreshCatalog()]);
    })().finally(() => { accountStatusRequest = null; broadcast(); });
    return accountStatusRequest;
  }
  function stopAccountServer() {
    pendingLogin.finish();
    server?.removeAllListeners(); server?.dispose(); server = null; connecting = null;
  }
  async function resetConnection() {
    for (const session of sessions.values()) { await save(session); session.loaded = false; }
    stopAccountServer(); activeConnection = null;
    account = null; catalog = []; catalogUpdatedAt = 0;
    accountRequestEpoch++; limitsEpoch++; limitsRequest = null;
    limits = {buckets:[],loading:false,updatedAt:null,error:false};
    broadcast();
    return connect();
  }
  async function configureConnection(id) {
    return withLocalSignIn(async () => {
      if (id === 'local') connections.select('local');
      else {
        const entry = connections.providers.get(id);
        if (!entry) throw Error('The connection extension is unavailable.');
        const outcome = await entry.provider.configure();
        if (outcome === 'cancel') return;
        connections.select(outcome === 'local' ? 'local' : id);
      }
      await resetConnection();
    });
  }
  async function chooseConnection() {
    if (pendingLogin.current) throw Error('Browser sign-in is pending. Complete or cancel it before changing connections.');
    const choice = await vscode.window.showQuickPick(connections.choices().map(item => ({label:item.label,id:item.id})), {title:'Rundix · '+locale.t('Подключение'),placeHolder:locale.t('Выберите или настройте подключение')});
    if (choice) await configureConnection(choice.id);
  }
  async function refreshLimits() {
    if (limitsRequest) return limitsRequest;
    if (!account || !["chatgpt", "chatgptAuthTokens"].includes(account.type)) {
      limits = { buckets: [], loading: false, updatedAt: null, error: false };
      broadcast();
      return;
    }
    const epoch = limitsEpoch,
      client = server;
    limits = { ...limits, loading: true };
    broadcast();
    limitsRequest = (async () => {
      try {
        const result = await client.request("account/rateLimits/read");
        if (epoch === limitsEpoch && client === server)
          limits = {
            buckets: require("./ui/limits.js").normalize(result),
            loading: false,
            updatedAt: Date.now(),
            error: false,
          };
      } catch {
        if (epoch === limitsEpoch && client === server)
          limits = { ...limits, loading: false, error: true };
      } finally {
        if (epoch === limitsEpoch && client === server) {
          limitsRequest = null;
          broadcast();
        }
      }
    })();
    return limitsRequest;
  }
  function updateDraftModel(s) {
    if(s.id || !catalog.length)return;
    if(!catalog.some(m=>m.model===s.model))
      s.model=[library.defaults.model,defaultModel,catalog[0]?.model].find(id=>catalog.some(m=>m.model===id));
    const model=catalog.find(m=>m.model===s.model);
    if(model && !model.supportedReasoningEfforts?.some(e=>e.reasoningEffort===s.effort))
      s.effort=[library.defaults.effort,defaultEffort,model.defaultReasoningEffort].find(e=>model.supportedReasoningEfforts?.some(v=>v.reasoningEffort===e));
  }
  async function refreshCatalog() {
    const client=server, accountId=identity(account), epoch=limitsEpoch;
    if(catalogRequest?.client===client && catalogRequest.epoch===epoch)return catalogRequest.promise;
    const request=(async()=>{
      const [available,config]=await Promise.all([
        readCatalog(client).catch(error=>{if(account)throw error;return [];}),
        client.request('config/read',{includeLayers:false}),
      ]);
      if(client!==server||identity(account)!==accountId||limitsEpoch!==epoch)return;
      catalog=available;catalogUpdatedAt=Date.now();
      defaultModel=config.config?.model || catalog.find(m=>m.isDefault)?.model;
      defaultEffort=config.config?.model_reasoning_effort;
      for(const s of sessions.values()){
        updateDraftModel(s);
        publish(s);
      }
    })();
    catalogRequest={client,epoch,promise:request};
    try{return await request;}finally{if(catalogRequest?.promise===request)catalogRequest=null;}
  }
  async function save(s) {
    const record = {
      key: s.key,
      id: s.id,
      name: s.name,
      customName: s.customName,
      model: s.model,
      effort: s.effort,
      prefs: s.prefs,
      draft: s.draft || "",
      attachments: s.attachments,
      followUps:s.followUps || [],
      queuePaused: !!s.queuePaused,
      asyncQuestionReplies:s.asyncQuestionReplies || {},
      questionHistory:s.questionHistory || [],
      preflight:s.preflight || null,
      cwd: s.cwd,
      parentId: s.parentId,
      items: s.items.slice(-200),
      tokenUsage: s.tokenUsage,
      usageModel: s.usageModel,
      usageStale: !!s.usageStale,
      lastTurnStatus:s.lastTurnStatus,
      mcpTask:!!s.mcpTask,
    };
    const written = store.saveSession(record, s.persistedRecord);
    for (const key of Object.keys(record))
      if (
        s.persistedRecord &&
        JSON.stringify(record[key]) === JSON.stringify(s.persistedRecord[key])
      )
        s[key] = written[key];
    s.persistedRecord = JSON.parse(JSON.stringify(written));
    await context.workspaceState.update("session:" + s.key, written);
  }
  function html(webview) {
    const nonce = randomBytes(18).toString("base64");
    const uri = (name) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, "ui", name),
      );
    return `<!doctype html><html lang="${locale.language}" data-language="${locale.language}" data-ui-version="${require("./package.json").version}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;"><link rel="stylesheet" href="${uri("app.css")}"></head><body><main id="app"></main><script nonce="${nonce}" src="${uri("translations.js")}"></script><script nonce="${nonce}" src="${uri("i18n.js")}"></script><script nonce="${nonce}" src="${uri("forms.js")}"></script><script nonce="${nonce}" src="${uri("questions.js")}"></script><script nonce="${nonce}" src="${uri("question-panel.js")}"></script><script nonce="${nonce}" src="${uri("task-preflight.js")}"></script><script nonce="${nonce}" src="${uri("icons.js")}"></script><script nonce="${nonce}" src="${uri("tabs.js")}"></script><script nonce="${nonce}" src="${uri("controls.js")}"></script><script nonce="${nonce}" src="${uri("toggles.js")}"></script><script nonce="${nonce}" src="${uri("modes.js")}"></script><script nonce="${nonce}" src="${uri("speed.js")}"></script><script nonce="${nonce}" src="${uri("changes.js")}"></script><script nonce="${nonce}" src="${uri("limits.js")}"></script><script nonce="${nonce}" src="${uri("limits-view.js")}"></script><script nonce="${nonce}" src="${uri("markdown.js")}"></script><script nonce="${nonce}" src="${uri("markdown-view.js")}"></script><script nonce="${nonce}" src="${uri("messages.js")}"></script><script nonce="${nonce}" src="${uri("activity.js")}"></script><script nonce="${nonce}" src="${uri("transcript-scroll.js")}"></script><script nonce="${nonce}" src="${uri("queued-editor.js")}"></script><script nonce="${nonce}" src="${uri("app.js")}"></script></body></html>`;
  }
  function saveHost(host) {
    const record = {
      hostKey: host.key,
      keys: [...host.keys],
      activeKey: host.activeKey,
    };
    store.saveHost(record);
    return context.workspaceState.update("host:" + host.key, record);
  }
  function activated(host) {
    lastHost = host;
    const s = sessions.get(host.activeKey);
    if (!s || !host.panel?.active) return;
    void library.touch(s, host.panel.viewColumn);
    if (library.get(s).unread)
      void library.update(s, { unread: false }).then(broadcast);
    void vscode.commands.executeCommand(
      "setContext",
      "rundix.active",
      true,
    );
  }
  async function syncExternal(s) {
    if (s.busy) return;
    const latest = store.session(s.key),
      base = s.persistedRecord;
    if (!latest || latest.revision === base?.revision) return;
    const changedHistory =
      !!s.id && JSON.stringify(latest.items) !== JSON.stringify(base?.items);
    if (changedHistory && s.loaded) {
      if ([...sessions.values()].some((other) => other.busy))
        throw Error(
          locale.t(
            "История обновилась в другом окне. Завершите текущие задачи в этом окне перед продолжением.",
          ),
        );
      if (pendingLogin.current?.client === server) pendingLogin.finish();
      server?.dispose();
      connecting = null;
    }
    for (const key of [
      "name",
      "customName",
      "draft",
      "attachments",
      "followUps",
      "queuePaused",
      "prefs",
      "preflight",
      "model",
      "effort",
      "cwd",
      "parentId",
      "items",
      "tokenUsage",
      "usageModel",
      "usageStale",
    ])
      if (
        JSON.stringify(s[key]) === JSON.stringify(base?.[key]) ||
        (key === "items" && changedHistory) || key==='preflight'
      )
        s[key] = latest[key];
    s.persistedRecord = JSON.parse(JSON.stringify(latest));
    if (changedHistory) { s.loaded = false; s.lastStartedTurnId = null; }
  }
  async function loadSelected(s) {
    try {
      await syncExternal(s);
      await connect();
      updateDraftModel(s);
      if (s.id && !s.loaded) await resume(s, s.id);
      s.error = null;
    } catch (error) {
      s.error = error.message;
    }
    publish(s);
  }
  function select(s, reveal = true) {
    if (!s?.panel) return;
    const host = s.host;
    host.activeKey = s.key;
    if (reveal) host.panel.reveal();
    activated(host);
    void saveHost(host);
    if (host.ready) void loadSelected(s);
    publish(s);
    treeEvents.fire();
    return s;
  }
  async function dispatch(host, msg) {
    if (!msg || typeof msg.action !== "string") return;
    const s = sessions.get(
      msg.action === "ready"
        ? host.activeKey
        : msg.sessionKey || host.activeKey,
    );
    if (!s || s.host !== host || !s.panel) {
      const active = sessions.get(host.activeKey);
      if (active) publish(active);
      return;
    }
    if (
      typeof msg.currentDraft === "string" &&
      msg.currentDraft.length <= 200000
    ) {
      s.draft = msg.currentDraft;
      await save(s);
    }
    if (msg.action === "activateTab") {
      const next = sessions.get(msg.tabKey);
      if (next?.host === host && next.panel) select(next);
      return;
    }
    if (msg.action === "closeTab") {
      const tab = sessions.get(msg.tabKey);
      if (tab?.host === host && tab.panel) await closeTab(tab);
      return;
    }
    if (msg.action === "renameTab") {
      const tab = sessions.get(msg.tabKey);
      if (tab?.host === host && tab.panel)
        await handle(tab, { action: "rename", name: msg.name });
      return;
    }
    if (msg.action === "forkTab" || msg.action === "moveTab") {
      const tab = sessions.get(msg.tabKey);
      if (tab?.host === host && tab.panel)
        return handle(tab, {
          action: msg.action === "forkTab" ? "fork" : "continueWindow",
        });
      return;
    }
    if (msg.action === "ready") host.ready = true;
    await handle(s, msg);
  }
  function createHost(panel, column, hostKey = randomUUID()) {
    const host = {
      key: hostKey,
      keys: [],
      activeKey: null,
      panel:
        panel ||
        vscode.window.createWebviewPanel(
          "rundix.session",
          "Rundix",
          column,
          {
            enableScripts: true,
            retainContextWhenHidden: false,
            localResourceRoots: [
              vscode.Uri.joinPath(context.extensionUri, "ui"),
              vscode.Uri.file(pastedImageRoot),
            ],
          },
        ),
    };
    hosts.set(host.key, host);
    lastHost = host;
    host.column = host.panel.viewColumn;
    host.panel.title = "Rundix";
    host.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "ui"),vscode.Uri.file(pastedImageRoot)],
    };
    host.panel.iconPath = {
      light: vscode.Uri.joinPath(
        context.extensionUri,
        "resources/rundix-light.svg",
      ),
      dark: vscode.Uri.joinPath(
        context.extensionUri,
        "resources/rundix-dark.svg",
      ),
    };
    let queue = Promise.resolve();
    async function replyToggle(msg, ok) {
      if (!['fast', 'settings', 'preferences', 'preflight', 'chatWidth', 'contextDisplay', 'cliSettings'].includes(msg?.action) ||
        typeof msg.sessionKey !== 'string' || msg.sessionKey.length > 128 ||
        typeof msg.toggleRequestId !== 'string' || !/^[\w-]{1,80}$/.test(msg.toggleRequestId)) return;
      const panel = host.panel;
      if (!panel) return;
      const session = sessions.get(msg.sessionKey);
      // publish() normally batches state for 40 ms. Send its final snapshot
      // before releasing the optimistic position, or the thumb would bounce back.
      if (session?.host === host) publish(session, true);
      try {
        await panel.webview.postMessage({ type: 'toggleResult', requestId: msg.toggleRequestId, key: msg.sessionKey, ok });
      } catch {
        output.appendLine('[ui] toggle-result-delivery-failed');
      }
    }
    const listener = host.panel.webview.onDidReceiveMessage((msg) => {
      if(msg?.action==='stop'){
        void dispatch(host,msg).catch(error=>{const s=sessions.get(host.activeKey);if(s){s.error=error.message;publish(s);}});
        return;
      }
      queue = queue
        .then(() => dispatch(host, msg))
        .then(() => replyToggle(msg, true), async (error) => {
          const s = sessions.get(host.activeKey);
          if (s) {
            s.error = error.message;
            publish(s);
          }
          await replyToggle(msg, false);
        });
    });
    host.panel.onDidChangeViewState(() => {
      host.column = host.panel?.viewColumn;
      activated(host);
      if (host.panel?.active && host.ready) {
        const active = sessions.get(host.activeKey);
        if (active) void loadSelected(active);
      }
      treeEvents.fire();
      void vscode.commands.executeCommand(
        "setContext",
        "rundix.active",
        [...hosts.values()].some((h) => h.panel?.active),
      );
    });
    host.panel.onDidDispose(() => {
      listener.dispose();
      if (host.timer) clearTimeout(host.timer);
      const column = host.column;
      host.panel = null;
      hosts.delete(host.key);
      for (const key of [...host.keys]) {
        const s = sessions.get(key);
        if (!s) continue;
        s.panel = null;
        delete s.queuedAttachmentDraft;
        void save(s);
        void library.close(s, column);
        if (!s.busy) sessions.delete(key);
      }
      void vscode.commands.executeCommand(
        "setContext",
        "rundix.hasClosed",
        library.closed.length > 0,
      );
      void vscode.commands.executeCommand(
        "setContext",
        "rundix.active",
        [...hosts.values()].some((h) => h.panel?.active),
      );
      treeEvents.fire();
    });
    host.panel.webview.html = html(host.panel.webview);
    return host;
  }
  function create(
    restored,
    panel,
    column = vscode.ViewColumn.Active,
    forcedHost,
    reveal = true,
  ) {
    const key = restored?.key || randomUUID(),
      saved =
        store.session(key) ||
        restored ||
        context.workspaceState.get("session:" + key) ||
        {},
      existing = sessions.get(key);
    if (existing?.panel && !panel) return select(existing);
    // Capture before creating/revealing a panel changes the active host.
    const inherited = restored ? {} : newSessionSettings(target(), cwd());
    const host = forcedHost || createHost(panel, column);
    const s = existing || {
      key,
      id: null,
      name: locale.t("Новая сессия {0}", nextDraft++),
      items: [],
      attachments: [],
      followUps: [],
      busy: false,
      cwd: cwd(),
      model: library.defaults.model,
      effort: library.defaults.effort,
      ...inherited,
      ...saved,
      prefs: {
        focus: false,
        showThinking: true,
        ide: false,
        plan: false,
        access: "workspace",
        ...inherited.prefs,
        ...saved.prefs,
      },
    };
    s.persistedRecord = saved;
    updateDraftModel(s);
    s.host = host;
    s.panel = host.panel;
    sessions.set(key, s);
    if (!host.keys.includes(key)) host.keys.push(key);
    void save(s);
    return select(s, !panel && reveal);
  }
  async function closeTab(s) {
    const host = s.host,
      index = host.keys.indexOf(s.key);
    if (index < 0) return;
    await save(s);
    await library.close(s, host.panel?.viewColumn);
    s.panel = null;
    delete s.queuedAttachmentDraft;
    host.keys.splice(index, 1);
    if (!s.busy) sessions.delete(s.key);
    void vscode.commands.executeCommand(
      "setContext",
      "rundix.hasClosed",
      true,
    );
    if (!host.keys.length) {
      host.panel.dispose();
      return;
    }
    if (host.activeKey === s.key)
      select(sessions.get(host.keys[Math.min(index, host.keys.length - 1)]));
    else publish(sessions.get(host.activeKey));
    await saveHost(host);
    treeEvents.fire();
  }
  // Per-thread Codex config for MCP task chats only, from the user's own settings (for example disabling helpers that pin the task folder).
  function mcpThreadConfig(s) {
    if(!s.mcpTask)return null;
    const value=vscode.workspace.getConfiguration('rundix').inspect('mcpThreadConfig')?.globalValue;
    return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length?value:null;
  }
  async function resume(s, id) {
    if (s.loading) return s.loading;
    s.loading = resumeThread(s, id);
    try {
      return await s.loading;
    } finally {
      s.loading = null;
    }
  }
  async function resumeThread(s, id) {
    // Serialize reloads with best-effort MCP cleanup, including a tab reopened while it is in flight.
    await threadReleases.get(id)?.catch(()=>{});
    await connect();
    if (s.id === id && s.loaded) return;
    const existing = [...sessions.values()].find(
      (other) => other !== s && other.id === id && other.panel,
    );
    if (existing) {
      select(existing);
      return;
    }
    const result = await server.request("thread/resume", {
      threadId: id,
      excludeTurns: true,
      ...(s.preflight?.enabled?{config:await preparationConfig(s),...(preflight.preparing(s.preflight)?{sandbox:'read-only',approvalPolicy:'never'}:{})}:mcpThreadConfig(s)?{config:mcpThreadConfig(s)}:{}),
    });
    s.id = id;
    s.cwd = result.thread.cwd || s.cwd;
    s.parentId = result.thread.forkedFromId || s.parentId;
    s.model = result.model;
    s.turnModel = result.model;
    s.effort = result.reasoningEffort;
    if(typeof s.prefs.fast!=='boolean')s.prefs.fast=['fast','priority'].includes(result.serviceTier);
    s.name = result.thread.name || result.thread.preview || "Rundix";
    s.busy = result.thread.status?.type === "active";
    if(!s.busy&&s.preflight?.phase==='executing')s.preflight.phase='review';
    {
      const turns = await server.request("thread/turns/list", {
        threadId: id,
        limit: 1,
        sortDirection: "desc",
        itemsView: "summary",
      });
      if (s.busy)
        s.turnId = turns.data?.find((turn) => turn.status === "inProgress")?.id;
      else s.lastTurnStatus=turns.data?.[0]?.status;
    }
    const page = await server.request("thread/items/list", {
      threadId: id,
      limit: 200,
      sortDirection: "desc",
    });
    const previousTimes = new Map(s.items.map(item => [item.id, item.timestamp]));
    s.items = (page.data || []).slice().reverse().map(entry => {
      const item = readItem(entry);
      item.timestamp ??= previousTimes.get(item.id);
      return item;
    });
    s.cursor = page.nextCursor;
    questionRecords.restore(s);
    s.loaded = true;
    await save(s);
    publish(s);
  }
  async function send(s, text, attached=s.attachments, options={}) {
    // retryable marks failures that happen before anything is sent and clear up by themselves; MCP tasks wait and retry.
    if (authBusy) throw Object.assign(Error(pendingLogin.current ? browserSignInMessage() : locale.t('Дождитесь переключения аккаунта.')),{notSent:true,retryable:true});
    if(s.sendingTask)throw Object.assign(Error(locale.t('Дождитесь обработки уточнений перед согласованием.')),{notSent:true,retryable:true});
    let accountLease;
    // Only a held lease is 'busy in another window'; file-system failures keep their own message and are not retried.
    try{accountLease = store.acquire('account-credentials');}catch(error){if(error?.syscall)throw Object.assign(error,{notSent:true});throw Object.assign(Error(browserSignInMessage(true)),{notSent:true,retryable:true});}
    let directoryLease=null, leasedDirectory=null;
    const ensureDirectory=()=>{
      const actual=taskDirectory.canonical(s.cwd || cwd());
      if(options.projectDirectory && actual!==options.projectDirectory)throw Error('MCP chat project directory changed.');
      if(actual!==leasedDirectory){const next=taskDirectory.acquire(store,actual,options.taskId);directoryLease?.();directoryLease=next;leasedDirectory=actual;}
    };
    s.sendingTask=true;
    // Everything thrown before turn/start is requested provably sent nothing; callers may retry or re-answer.
    let turnRequested=false;
    try {
    if (s.busy)
      throw Error(locale.t("Дождитесь ответа или остановите текущую задачу."));
    if (typeof text !== "string" || (!text.trim() && !attached.some(file=>file.kind==='image')) || text.length > 200000)
      throw Error(locale.t("Введите сообщение длиной до 200 000 символов."));
    if (!vscode.workspace.isTrusted)
      throw Error(
        locale.t("Сначала разрешите доверие рабочему пространству VS Code."),
      );
    await syncExternal(s);
    ensureDirectory();
    await applyPendingMode(s);
    const accountRevisionBeforeConnect=accountReadRevision;
    await connect();
    if(options.requiredConnection && (activeConnection?.id!==options.requiredConnection.id || activeConnection?.revision!==options.requiredConnection.revision || !activeConnection?.provider))throw Error('MCP task connection changed.');
    connections.assertCurrent(activeConnection);
    if (activeConnection.provider) await activeConnection.provider.authenticate(providerClient(server, activeConnection));
    // A cold connection already read the account and loaded its model catalog.
    const initializedHere=accountReadRevision!==accountRevisionBeforeConnect;
    const accountChanged=initializedHere ? false : await refreshAccount();
    if (!account) throw Error(locale.t("Войдите в Codex через /account."));
    await Promise.all([
      initializedHere && limits.updatedAt && !limits.error ? (limitsRequest || Promise.resolve()) : refreshLimits(),
      accountChanged || Date.now()-catalogUpdatedAt>60000 ? refreshCatalog() : Promise.resolve(),
    ]);
    if (activeConnection.provider?.prepareTurn) {
      const connection = activeConnection;
      const assertCanChange = () => {
        connections.assertCurrent(connection);
        if ([...sessions.values()].some(session => session.busy || session.compacting)) throw Object.assign(Error('Finish active tasks before changing the connection.'),{retryable:true});
        try{store.assertNoActiveTurns();}catch(error){throw Object.assign(error,{retryable:true});}
      };
      const decision = await connection.provider.prepareTurn({
        limits: {...limits},
        assertCanChange,
        reconnect: async () => {
          assertCanChange();
          await resetConnection();
        },
        readLimits: async () => { await refreshLimits(); return {...limits}; },
      });
      connections.assertCurrent(connection);
      if (decision?.waitUntil) return {waitUntil:decision.waitUntil,connection};
    }
    const exhausted = require('./ui/limits.js').exhaustion(limits);
    if(options.requiredConnection && (activeConnection?.id!==options.requiredConnection.id || activeConnection?.revision!==options.requiredConnection.revision || !activeConnection?.provider))throw Error('MCP task connection changed.');
    if(exhausted){
      const date=exhausted.resetAt?new Intl.DateTimeFormat(undefined,{dateStyle:'short',timeStyle:'short'}).format(exhausted.resetAt):null;
      throw Error(date?locale.t('Лимиты аккаунта закончились. Дождитесь сброса: {0}. Запрос сохранён.',date):locale.t('Лимиты аккаунта закончились. Дождитесь сброса лимитов. Запрос сохранён.'));
    }
    updateDraftModel(s);
    const selection={model:s.model,effort:s.effort,fast:s.prefs.fast,...options.modelSelection};
    if (s.id && !s.loaded) await resume(s, s.id);
    ensureDirectory();
    const selectedModel=catalog.find(model=>model.model===selection.model);
    if (!selectedModel)
      throw Error(
        locale.t(
          "Выберите модель, доступную текущему аккаунту. Контекст сессии сохранён.",
        ),
      );
    if(selection.effort && !selectedModel.supportedReasoningEfforts.some(option=>option.reasoningEffort===selection.effort))
      throw Error(locale.t("Эта модель не поддерживает выбранную глубину."));
    if(options.approvedTask && (!s.preflight?.enabled || hasPendingQuestions(s)))
      throw Error(locale.t('План изменился или ещё не готов к согласованию.'));
    if(s.preflight?.enabled){
      if(options.approvedTask){
        preflight.approve(s.preflight,options.approvedTask.id,options.approvedTask.revision);
      }else preflight.revise(s.preflight);
      await save(s);
    }
    const preparing=preflight.preparing(s.preflight);
    const mode = modes.current(s.prefs),
      policy = preparing?preflight.policy():modes.policy(mode.id, s.cwd || cwd()),
      { approvalPolicy, approvalsReviewer, sandboxPolicy } = policy;
    const serviceTier=speed.effectiveTier(selectedModel,selection.fast===true);
    if (!s.id) {
      const result = await server.request("thread/start", {
        cwd: s.cwd || cwd(),
        model: selection.model,
        approvalPolicy,
        approvalsReviewer,
        sandbox: policy.sandbox,
        serviceTier:serviceTier==='default'?null:serviceTier,
        ...(s.preflight?.enabled?{config:await preparationConfig(s)}:mcpThreadConfig(s)?{config:mcpThreadConfig(s)}:{}),
      });
      s.id = result.thread.id;
      s.cwd = result.thread.cwd || s.cwd;
      await library.migrate(s.key, s.id);
      s.loaded = true;
      s.model = result.model;
      s.effort = s.effort || result.reasoningEffort;
      if (!s.customName) s.name = text.trim().replace(/\s+/g, " ").slice(0, 64) || locale.t('Изображение');
      await server.request("thread/name/set", { threadId: s.id, name: s.name });
      await save(s);
    }
    ensureDirectory();
    const input = buildInput(text, attached, options.includeIde!==false && s.prefs.ide && lastEditor?.document.uri.scheme==='file'
      ? {path:lastEditor.document.uri.fsPath,text:lastEditor.document.getText(lastEditor.selection).slice(0,20000)} : null);
    const sessionRelease = store.acquire(s.id), releaseDirectory=directoryLease;
    const client=server, connection=activeConnection, threadId=s.id,
      previousTurnId=s.turnId || s.lastStartedTurnId || [...s.items].reverse().find(item=>item.turnId)?.turnId;
    let unresolved=true, startPending=true, startUncertain=false, released=false, observed=null;
    let reconciliationTimer, reconciliationDeadline;
    const stopReconciliation=()=>{
      if(reconciliationTimer!==undefined)clearTimeout(reconciliationTimer);
      if(reconciliationDeadline!==undefined)clearTimeout(reconciliationDeadline);
    };
    const current=()=>server===client && activeConnection===connection && s.id===threadId;
    const release = () => {
      // Disconnect cleanup cannot turn an unanswered mutation into a clean failure.
      if(unresolved || (startPending || startUncertain) && observed?.status==='inProgress' || released)return;
      released=true;stopReconciliation();sessionRelease();releaseDirectory?.();
      client.removeListener?.('notification',observeTurn);
      client.removeListener?.('disconnected',observeDisconnect);
      if(turnLeases.get(threadId)===release)turnLeases.delete(threadId);
    };
    const observeTurn=message=>{
      const p=message.params;
      if(!current() || p?.threadId!==threadId || !p.turn?.id || p.turn.id===previousTurnId ||
        !['turn/started','turn/completed'].includes(message.method))return;
      if(observed && observed.id!==p.turn.id)return;
      observed={id:p.turn.id,status:message.method==='turn/started'?'inProgress':p.turn.status};
      s.lastStartedTurnId=p.turn.id;
      stopReconciliation();
      unresolved=false;
      s.busy=message.method==='turn/started';s.turnId=s.busy?p.turn.id:null;
      if(!s.busy){s.lastTurnStatus=p.turn.status;release();}
    };
    // The Codex process is gone, so no turn of this request can still run: free the chat.
    // The pending request still rejects as deliveryUncertain, so queued input is never replayed.
    const observeDisconnect=()=>{unresolved=false;startPending=false;startUncertain=false;observed=null;release();};
    client.on?.('notification',observeTurn);
    client.on?.('disconnected',observeDisconnect);
    directoryLease=null;
    turnLeases.set(s.id, release);
    s.error = null;
    s.stopRequested=false;
    s.busy = true;
    s.turnId = null;
    s.turnModel = selection.model;
    s.turnStartedAt=Date.now();
    publish(s);
    try {
      turnRequested=true;
      const result = await client.request("turn/start", {
        threadId: s.id,
        serviceTierForTurn:serviceTier,
        input,
        cwd: s.cwd,
        model: selection.model,
        effort: selection.effort,
        approvalPolicy,
        approvalsReviewer,
        sandboxPolicy,
        ...(preparing?{outputSchema:preflight.schema}:options.outputSchema?{outputSchema:options.outputSchema}:{}),
        collaborationMode: {
          // Our JSON proposal has its own workflow; native Plan uses a different final format.
          mode: s.preflight?.enabled ? 'default' : s.prefs.plan ? 'plan' : 'default',
          settings: {
            model: selection.model,
            reasoning_effort: selection.effort,
            developer_instructions: (options.taskId || options.projectDirectory
              ? 'The requester is an automated agent client; no human watches this task chat. Decide routine implementation details yourself. When a decision really requires the client, use the blocking request_user_input tool with concise options. Put the recommended option first and mark its label (Recommended). Never use request_user_input_async and never wait for a human in the chat. A skipped question or empty answers are not consent or a selection; continue with reasonable assumptions where possible.'
              : s.preflight?.enabled?preflight.instructions(s.preflight):'When a clarification would materially improve the task, ask a concise structured quiz using request_user_input or request_user_input_async when available. Put the recommended option first and mark its label (Recommended). Ask when the user requests a quiz. Do not ask about routine implementation details. A skipped quiz or empty answers are not consent or a selection; continue with reasonable assumptions where possible.') +
              (s.prefs.focus?' Before using tools for a task, send a brief user-facing commentary explaining your next action. During longer work, send concise commentary at meaningful progress boundaries before the related tool steps. Use commentary messages for these updates, not tool output or private reasoning. Do not invent progress or delay direct answers that require no tools.':''),
          },
        },
      });
      startPending=false;unresolved=false;
      if(current())s.lastStartedTurnId=result.turn.id;
      observed ||= {id:result.turn.id,status:s.busy?'inProgress':'completed'};
      if(!s.busy)release();
      if (current() && s.busy) s.turnId = result.turn.id;
      if(current() && s.busy && s.stopRequested)await client.request('turn/interrupt',{threadId,turnId:result.turn.id});
      const consumed=new Set(attached.map(file=>file.id));s.attachments=s.attachments.filter(file=>!consumed.has(file.id));
      return {turnId:result.turn.id};
    } catch (error) {
      startPending=false;
      if(!observed && error.deliveryUncertain===false){
        unresolved=false;release();
        if(current())s.busy=false;
      }else{
        // Unknown errors are conservative too: never automatically resend input.
        startUncertain=true;
        error.deliveryUncertain=true;
        if(!observed && current()){
          const owns=()=>!observed && !released && current() && turnLeases.get(threadId)===release;
          const reconciliationStarted=Date.now();
          // Bound even repeated RPC failures; expiry never makes input safe to replay.
          const expire=()=>{
            if(!owns())return;
            unresolved=false;s.busy=false;s.turnId=null;
            s.error=locale.language==='en'
              ? 'Message delivery could not be confirmed. Check the chat before resending.'
              : 'Не удалось подтвердить доставку сообщения. Проверьте чат перед повторной отправкой.';
            release();publish(s);
          };
          const reconcile=async()=>{
            if(!owns())return;
            try{
            const turns=await client.request('thread/turns/list',{
              threadId,limit:1,sortDirection:'desc',itemsView:'summary',
            },5000);
            // A notification wins over a stale list response, as does a new owner.
            if(owns() && Array.isArray(turns.data)){
              const turn=turns.data[0];
              if(turn?.id && turn.id!==previousTurnId && ['inProgress','completed','interrupted','failed'].includes(turn.status)){
                observed={id:turn.id,status:turn.status};unresolved=false;stopReconciliation();
                s.lastStartedTurnId=turn.id;
                s.busy=turn.status==='inProgress';s.turnId=s.busy?turn.id:null;
                if(!s.busy){s.lastTurnStatus=turn.status;release();}
                publish(s);
              }
            }
            }catch{ /* An unavailable list is unresolved, just like an empty or previous turn. */ }
            if(owns()){
              reconciliationTimer=setTimeout(()=>{void reconcile();},5000);
              reconciliationTimer.unref?.();
            }
          };
          await reconcile();
          if(owns()){
            reconciliationDeadline=setTimeout(expire,Math.max(0,30000-(Date.now()-reconciliationStarted)));
            reconciliationDeadline.unref?.();
          }
        }
      }
      throw error;
    } finally {
      publish(s);
    }
    } catch (error) {
      if (!turnRequested && error && typeof error === 'object') error.notSent = true;
      throw error;
    } finally { s.sendingTask=false;directoryLease?.();accountLease(); }
  }
  async function preparationConfig(s){
    const client=server;
    const result=await client.request('config/read',{includeLayers:false,cwd:s.cwd||cwd()});
    if(client!==server)throw Error(locale.t('Соединение изменилось. Повторите подготовку задачи.'));
    return preflight.restrictedConfig(result.config);
  }
  function hasPendingQuestions(s) {
    const unanswered = s.items.some(item =>
      asyncQuestions.questions(item).length &&
      (!s.asyncQuestionReplies?.[item.id] || s.asyncQuestionReplies[item.id]==='unknown' && !s.mcpTask) &&
      !asyncQuestions.hasReply(s.items, item.id));
    return unanswered || [...pendingRequests.values()].some(request => request.params?.threadId === s.id);
  }
  async function setMode(s, id) {
    const selected = modes.modes.find((m) => m.id === id);
    if (!selected) throw Error(locale.t("Неизвестный режим работы."));
    if(s.busy || s.modeChange){
      s.prefs.pendingMode=!s.modeChange && id===modes.current(s.prefs).id?null:id;
      await save(s);publish(s);return;
    }
    s.prefs.pendingMode=null;
    await applyMode(s,id);
  }
  async function queueFollowUp(s,text,attachments){
    if(s.queueMutation)throw Error(locale.t('Дождитесь сохранения очереди.'));
    const releaseQueue=acquireQueuedSession(s,key=>store.acquire(key));
    let finishEnqueue;
    s.queueEnqueue=new Promise(resolve=>{finishEnqueue=resolve;});
    s.queueMutation=true;s.queueDrainDeferred=false;
    try {
      assertQueueCurrent(s,store.session(s.key));
      const queue=s.followUps || [];
      if(queue.length>=20)throw Error(locale.t('В очереди уже 20 сообщений.'));
      const item={id:randomUUID(),text,attachments:[...attachments],
        modelSelection:typeof s.model==='string'?{model:s.model,effort:s.effort,fast:s.prefs.fast===true}:undefined};
      const consumed=new Set(attachments.map(file=>file.id)), draft=s.draft, previousRecord=s.persistedRecord;
      const snapshot={...s,followUps:[...queue,item],attachments:s.attachments.filter(file=>!consumed.has(file.id)),
        draft:draft===text?'':draft};
      try{await save(snapshot);}catch(error){
        if(snapshot.persistedRecord===previousRecord)throw error;
        // The local atomic record is authoritative even if the VS Code cache failed.
        output.appendLine('[queue] workspace-state-update-failed');
      }
      s.followUps=snapshot.followUps;s.persistedRecord=snapshot.persistedRecord;
      s.attachments=s.attachments.filter(file=>!consumed.has(file.id));
      if(s.draft===draft)s.draft=snapshot.draft;
      publish(s);return item;
    } finally {
      const deferred=s.queueDrainDeferred;
      s.queueMutation=false;s.queueDrainDeferred=false;s.queueEnqueue=null;finishEnqueue();releaseQueue();
      if(deferred && !s.busy && !s.queuePaused && !s.error)
        void drainFollowUps(s).catch(error=>{s.error=error.message;publish(s);});
    }
  }
  async function steer(s,text,attachments){
    if(!s.id || !s.turnId || s.compacting)return false;
    const expectedTurnId=s.turnId;
    try{
      await server.request('turn/steer',{threadId:s.id,expectedTurnId,input:buildInput(text,attachments)});
      const consumed=new Set(attachments.map(file=>file.id));s.attachments=s.attachments.filter(file=>!consumed.has(file.id));
      await save(s);publish(s);return true;
    }catch(error){
      // Only a definite refusal can be queued; a timeout might already have been accepted.
      if(/no active turn|not active|expected.*turn.*(?:match|different)|turn.*mismatch/i.test(error.message))return false;
      throw error;
    }
  }
  async function drainFollowUps(s,{manual=false}={}){
    if(s.busy || s.followUpSending || s.queuePaused && !manual || !s.followUps?.length)return;
    if(s.queueMutation){if(!manual)s.queueDrainDeferred=true;return;}
    const releaseQueue=acquireQueuedSession(s,key=>store.acquire(key));
    try {
      assertQueueCurrent(s,store.session(s.key));
      const item=s.followUps[0];s.followUpSending=true;publish(s);
      try{
        if(item.deliveryUncertain)throw Error(locale.t('Доставка сообщения не подтверждена. Проверьте чат перед повторной отправкой.'));
        await applyPendingMode(s);
        const result=await send(s,item.text,item.attachments,{modelSelection:item.modelSelection});
        if(result?.waitUntil)throw Error(locale.t('Очередь ожидает сброса лимитов. Повторите отправку позже.'));
        // Enqueue may be persisting a snapshot containing this in-flight item.
        await s.queueEnqueue;
        s.followUps=s.followUps.filter(row=>row.id!==item.id);await save(s);publish(s);
      }catch(error){
        if(error.deliveryUncertain){
          await s.queueEnqueue;
          const queued=s.followUps.find(row=>row.id===item.id);
          if(queued){queued.deliveryUncertain=true;await save(s);}
        }
        s.error=error.message;throw error;
      }finally{
        s.followUpSending=false;publish(s);
        if(!s.busy && s.lastTurnStatus==='completed' && !s.stopRequested && s.followUps?.length && !s.error)
          setTimeout(()=>void drainFollowUps(s).catch(error=>{s.error=error.message;publish(s);}),0);
      }
    } finally {releaseQueue();}
  }
  async function applyPendingMode(s){
    if(s.modeChange)return s.modeChange;
    if(s.busy || !s.prefs.pendingMode)return;
    const pending=(async()=>{
      while(!s.busy && s.prefs.pendingMode){
        const id=s.prefs.pendingMode;
        await applyMode(s,id);
        if(s.prefs.pendingMode===id)s.prefs.pendingMode=null;
        await save(s);publish(s);
      }
    })();
    s.modeChange=pending;
    try{await pending;}finally{s.modeChange=null;}
  }
  async function applyMode(s,id){
    const selected=modes.modes.find(mode=>mode.id===id);
    if(!selected)throw Error(locale.t('Неизвестный режим работы.'));
    if (s.id && !preflight.preparing(s.preflight)) {
      await connect();
      if (!s.loaded) await resume(s, s.id);
      const { approvalPolicy, approvalsReviewer, sandboxPolicy } = modes.policy(
        id,
        s.cwd,
      );
      await server.request("thread/settings/update", {
        threadId: s.id,
        approvalPolicy,
        approvalsReviewer,
        sandboxPolicy,
        collaborationMode: {
          mode: selected.plan ? "plan" : "default",
          settings: {
            model: s.model,
            reasoning_effort: s.effort,
            developer_instructions: null,
          },
        },
      });
    }
    s.prefs = {
      ...s.prefs,
      mode: id,
      access: selected.access,
      plan: !!selected.plan,
    };
    await save(s);
    publish(s);
  }
  async function commitQueueChange(s, change, { resume = true } = {}) {
    if (s.queueMutation) throw Error(locale.t('Дождитесь сохранения очереди.'));
    const releaseQueue=acquireQueuedSession(s,key=>store.acquire(key));
    const previousRecord = s.persistedRecord, previousQueue = s.followUps, previousPause = s.queuePaused;
    let committed = false;
    s.queueDrainDeferred = false;
    s.queueMutation = true;
    try {
      change();
      try { await save(s); }
      catch (error) {
        if (s.persistedRecord === previousRecord) { s.followUps = previousQueue;s.queuePaused = previousPause;throw error; }
        output.appendLine('[queue] workspace-state-update-failed');
      }
      committed = true;
    } finally {
      const deferred = s.queueDrainDeferred;
      s.queueDrainDeferred = false;s.queueMutation = false;publish(s);
      releaseQueue();
      if (committed && resume && deferred && !s.queuePaused && !s.busy && s.lastTurnStatus === 'completed' && !s.stopRequested && !s.error)
        void drainFollowUps(s).catch(error => { s.error = error.message;publish(s); });
    }
  }
  async function handle(s, msg) {
    if(msg.action==='mcpPanel'){openMcpEditor();return;}
    if (!msg || typeof msg.action !== "string") return;
    if (!["draft", "history"].includes(msg.action)) s.error = null;
    if(msg.action==='preflight'){
      if(s.id||s.busy||s.sendingTask||s.followUpSending||s.followUps?.length)throw Error(locale.t('Включайте подготовку перед первым сообщением нового чата.'));
      s.preflight=msg.enabled===true?preflight.begin():null;
      await save(s);publish(s);
    } else if(msg.action==='approveTask'){
      if(s.busy||s.sendingTask||s.followUpSending||s.followUps?.length||s.approvingTask)throw Error(locale.t('Дождитесь обработки уточнений перед согласованием.'));
      s.approvingTask=true;
      try{
        const result=await send(s,locale.t('Выполнить согласованный план.'),[],{includeIde:false,approvedTask:{id:msg.id,revision:msg.revision}});
        if(result?.waitUntil)throw Error(locale.t('Очередь ожидает сброса лимитов. Повторите отправку позже.'));
      }catch(error){
        if(!s.busy&&s.preflight?.phase==='executing')s.preflight.phase='clarifying';
        await save(s);throw error;
      }finally{s.approvingTask=false;publish(s);}
    } else if (msg.action === "limits") {
      await connect();
      await refreshAccount();
      await refreshLimits();
    } else if(msg.action==='models') {
      await connect();await refreshAccount();await refreshCatalog();
    } else if(msg.action==='cliSettings') {
      const config=vscode.workspace.getConfiguration('rundix');
      if(['stable','alpha'].includes(msg.channel))await config.update('cliChannel',msg.channel,vscode.ConfigurationTarget.Global);
      if(typeof msg.autoUpdate==='boolean')await config.update('cliAutoUpdate',msg.autoUpdate,vscode.ConfigurationTarget.Global);
      broadcast();
    } else if(msg.action==='cliCheck') {
      void checkCliUpdates(true);
    } else if (msg.action === "ready") {
      await connect();
      if (s.id && !s.loaded) await resume(s, s.id);
      publish(s);
    } else if (msg.action === 'queuePause') {
      if (typeof msg.paused !== 'boolean') throw Error('Invalid queue pause');
      await commitQueueChange(s, () => { assertQueueCurrent(s, store.session(s.key));s.queuePaused = msg.paused; }, { resume: false });
      if (!msg.paused && !s.busy) await drainFollowUps(s);
    } else if (msg.action === 'moveQueued') {
      await commitQueueChange(s, () => { s.followUps = moveQueued(s, msg, store.session(s.key)); });
    } else if (msg.action === 'transferQueued') {
      return transferQueuedSession(s,msg,{
        acquire:key=>store.acquire(key),
        latest:()=>store.session(s.key),destination:key=>store.session(key),
        writeDestination:record=>store.saveSession(record),save,publish,
        diagnostic:category=>output.appendLine('[queue-transfer] '+category),
        open:record=>create(record),
        resume:source=>{
          if (!source.busy && !source.queuePaused && source.lastTurnStatus==='completed' && !source.stopRequested && !source.error)
            void drainFollowUps(source).catch(error=>{source.error=error.message;publish(source);});
        },
        start:async(destination,modelSelection)=>{
          if(!destination.panel)return;
          try {
            const result=await send(destination,destination.draft,destination.attachments,{modelSelection});
            if(result?.waitUntil)throw Error(locale.t('Очередь ожидает сброса лимитов. Повторите отправку позже.'));
            destination.draft='';await save(destination);publish(destination);
            await destination.panel?.webview.postMessage({type:'sent',key:destination.key});
          } catch(error) {destination.error=error.message;publish(destination);}
        },
      });
    } else if (msg.action === 'cancelQueuedEdit') {
      if (s.queuedAttachmentDraft?.editId === msg.editId) delete s.queuedAttachmentDraft;
    } else if (['pickQueuedFiles', 'pasteQueuedImage'].includes(msg.action)) {
      if (typeof msg.requestId !== 'string' || !/^[\w-]{1,100}$/.test(msg.requestId)) throw Error('Invalid queue attachment request');
      try {
        const files = await stageQueuedAttachments(s, msg, { latest: () => store.session(s.key),
          pickFiles: () => vscode.window.showOpenDialog({ canSelectMany: true, openLabel: locale.t('Добавить в контекст') }),
          pasteImage: data => savePastedImage(pastedImageRoot, data) });
        await s.panel?.webview.postMessage({ type: 'queuedAttachmentsResult', key: s.key, editId: msg.editId,
          requestId: msg.requestId, ok: true, attachments: files.map(file => ({id:file.id,name:file.name,kind:file.kind})) });
      } catch (error) {
        await s.panel?.webview.postMessage({ type: 'queuedAttachmentsResult', key: s.key, editId: msg.editId, requestId: msg.requestId, ok: false });
        throw error;
      }
    } else if (msg.action === 'editQueued') {
      if(typeof msg.requestId !== 'string' || !/^[\w-]{1,100}$/.test(msg.requestId))throw Error('Invalid queue edit request');
      try {
        await commitQueueChange(s, () => {
          const item = queuedEdit(s, msg, store.session(s.key));
          const attachments = selectedAttachments(s, msg, item);
          s.followUps = s.followUps.map(row => row.id === item.id ? { ...item, text: msg.text, attachments } : row);
        });
        if (s.queuedAttachmentDraft?.editId === msg.editId) delete s.queuedAttachmentDraft;
      } catch (error) {
        await s.panel?.webview.postMessage({type:'queuedEditResult',key:s.key,requestId:msg.requestId,ok:false});
        throw error;
      }
      await s.panel?.webview.postMessage({type:'queuedEditResult',key:s.key,requestId:msg.requestId,ok:true});
    } else if (msg.action === 'removeQueued') {
      if(s.followUpSending)throw Error(locale.t('Дождитесь отправки сообщения из очереди.'));
      const releaseQueue=acquireQueuedSession(s,key=>store.acquire(key));
      try {
        assertQueueCurrent(s,store.session(s.key));
        s.followUps=(s.followUps || []).filter(item=>item.id!==msg.id);
        for(const [id,status] of Object.entries(s.asyncQuestionReplies || {})){
          if(status==='queued' && !asyncQuestions.hasReply(s.items,id) &&
            !asyncQuestions.hasReply(s.followUps.map(item=>({type:'userMessage',text:item.text})),id)){
              delete s.asyncQuestionReplies[id];
              s.questionHistory=(s.questionHistory || []).filter(record=>record.id!=='a:'+id);
            }
        }
        await save(s);publish(s);
      } finally {releaseQueue();}
    } else if (msg.action === 'sendQueued') {
      s.error=null;await drainFollowUps(s,{manual:true});
    } else if(msg.action==='steerQueued') {
      if(s.followUpSending || !s.busy || s.compacting)return;
      const releaseQueue=acquireQueuedSession(s,key=>store.acquire(key));
      try {
        assertQueueCurrent(s,store.session(s.key));
        const item=s.followUps?.find(item=>item.id===msg.id);
        if(!item || item.deliveryUncertain)return;
        s.followUpSending=true;publish(s);
        try{
          if(await steer(s,item.text,item.attachments)){
            await s.queueEnqueue;
            s.followUps=s.followUps.filter(row=>row.id!==item.id);
            await save(s);
          }
        }catch(error){
          // A lost response may already have delivered this input. Never replay it automatically.
          await s.queueEnqueue;
          const queued=s.followUps.find(row=>row.id===item.id);
          if(queued){queued.deliveryUncertain=true;await save(s);}throw error;
        }finally{
          s.followUpSending=false;publish(s);
          if(!s.busy && s.lastTurnStatus==='completed' && !s.stopRequested && !item.deliveryUncertain)
            void drainFollowUps(s).catch(error=>{s.error=error.message;publish(s);});
        }
      } finally {releaseQueue();}
    } else if(msg.action==='answerAsync') {
      const delivery=require('./runtime/mcp-delivery.cjs');
      if(s.asyncQuestionSending)throw Error('Wait for the question answer to finish sending.');
      const item=s.items.find(item=>item.id===msg.itemId);
      const previousReply=s.asyncQuestionReplies?.[msg.itemId];
      if(!item || (s.asyncQuestionReplies?.[item.id] && (s.asyncQuestionReplies[item.id]!=='unknown' || s.mcpTask || typeof msg.sendReply==='function')) || asyncQuestions.hasReply(s.items,item.id))throw Error('This question has already been answered or is unavailable.');
      if(mcpTasks && [...mcpTasks.tasks.values()].some(task=>task.sessionKey===s.key && task.cancelledAsyncItems?.includes(item.id)))throw Error('This question belongs to a cancelled task run.');
      const text=asyncQuestions.buildReply(item,msg.answers,{skip:msg.skip===true});
      // In an MCP task chat, answer through the task so its directory lease, connection and report stay consistent.
      const owner=typeof msg.sendReply!=='function' && mcpTasks?[...mcpTasks.tasks.values()].find(task=>task.sessionKey===s.key && mcpTasks.adapter.pending(task).some(request=>request.id==='async-question:'+item.id)):null;
      if(owner){
        await mcpTasks.call('continue_task',{requestId:randomUUID(),taskId:owner.taskId,approval:{id:'async-question:'+item.id,...(msg.skip===true?{skip:true}:{answers:msg.answers})}});
        return;
      }
      if(preflight.preparing(s.preflight))s.preflight.skipped=msg.skip===true;
      s.asyncQuestionSending=item.id;publish(s);
      let attempted=false;
      try{
        // Persist before any mutating RPC so a crash or lost reply preserves delivery uncertainty.
        s.asyncQuestionReplies={...s.asyncQuestionReplies,[item.id]:'unknown'};
        await save(s);
        let queued=false;
        const sendReply=async()=>{
          attempted=true;
          const result=await (typeof msg.sendReply==='function'?msg.sendReply(text):send(s,text,[],{includeIde:false}));
          if(result?.waitUntil)throw Object.assign(Error(locale.t('Очередь ожидает сброса лимитов. Повторите отправку позже.')),{notSent:true});
        };
        if(s.busy){
          attempted=true;
          if(!await steer(s,text,[])){
            attempted=false;
            if(typeof msg.sendReply==='function'){
              if(s.busy)throw Object.assign(Error('The turn is finishing. Retry the question answer after its status updates.'),{notSent:true});
              await sendReply();
            }else{await queueFollowUp(s,text,[]);queued=true;}
          }
        }else await sendReply();
        s.asyncQuestionReplies={...s.asyncQuestionReplies,[item.id]:queued?'queued':msg.skip===true?'skipped':'sent'};
        questionRecords.remember(s,{id:'a:'+item.id,origin:'async',parentItemId:item.id,questions:questionRecords.fromAsync(item),answers:msg.answers,skipped:msg.skip===true,status:queued?'queued':'sent'});
        await save(s);
      }catch(error){
        s.asyncQuestionReplies={...s.asyncQuestionReplies};
        if(!attempted || delivery.refused(error)){
          if(previousReply==='unknown')s.asyncQuestionReplies[item.id]='unknown';
          else delete s.asyncQuestionReplies[item.id];
          await save(s);throw Object.assign(error,{deliveryOutcome:'rejected'});
        }
        s.asyncQuestionReplies[item.id]='unknown';
        try{await save(s);}catch{}
        throw delivery.unknown(error);
      }finally{s.asyncQuestionSending=null;publish(s);}
    } else if (msg.action === "send" || msg.action === 'enqueue') {
      if(s.approvingTask)throw Error(locale.t('Дождитесь обработки уточнений перед согласованием.'));
      if(preflight.preparing(s.preflight))s.preflight.skipped=false;
      if (typeof msg.text === 'string' && msg.text.length <= 200000) {
        s.draft = msg.text;
        await save(s);
      }
      if(typeof msg.text!=='string'||msg.text.length>200000 || (!msg.text.trim()&&!s.attachments.some(file=>file.kind==='image')))throw Error(locale.t('Введите сообщение длиной до 200 000 символов.'));
      // Follow-ups wait by default; steering is an explicit action on a pending message.
      if(s.busy || s.followUpSending || s.followUps?.length || msg.action==='enqueue'){
        await queueFollowUp(s,msg.text,[...s.attachments]);
        await s.panel?.webview.postMessage({type:'sent',key:s.key});
        if(!s.busy)await drainFollowUps(s);
        return;
      }
      let sendResult = await send(s, msg.text);
      while (sendResult?.waitUntil) {
        connections.assertCurrent(sendResult.connection);
        const waitingConnection = sendResult.connection;
        const proceed = await waitingConnection.provider.waitForReset(sendResult.waitUntil, () => {
          try { connections.assertCurrent(waitingConnection); return !!s.panel; } catch { return false; }
        });
        if (!proceed) throw Error('Waiting cancelled. Your draft is preserved.');
        connections.assertCurrent(sendResult.connection);
        sendResult = await send(s, msg.text);
      }
      s.draft = "";
      await save(s);
      await s.panel?.webview.postMessage({ type: "sent", key: s.key });
    } else if (msg.action === "draft") {
      if (typeof msg.text === "string" && msg.text.length <= 200000) {
        s.draft = msg.text;
        await save(s);
      }
    } else if (msg.action === "stop") {
      s.stopRequested=true;
      if (s.id && s.turnId)
        await server.request("turn/interrupt", {
          threadId: s.id,
          turnId: s.turnId,
        });
    } else if (msg.action === "language") {
      if (!["auto", "en", "ru"].includes(msg.language))
        throw Error("Unsupported interface language.");
      if (
        typeof msg.currentDraft === "string" &&
        msg.currentDraft.length <= 200000
      ) {
        s.draft = msg.currentDraft;
        await save(s);
      }
      await vscode.workspace
        .getConfiguration("rundix")
        .update("language", msg.language, vscode.ConfigurationTarget.Global);
    } else if (msg.action === "new") create();
    else if (msg.action === "fork") {
      if (!s.id || s.busy)
        throw Error(
          locale.t(
            "Ветку можно создать после завершения задачи в сохранённой сессии.",
          ),
        );
      await connect();
      const item = msg.itemId
        ? s.items.find(
            (item) =>
              item.id === msg.itemId &&
              item.type === "agentMessage" &&
              item.turnId,
          )
        : null;
      if (msg.itemId && !item)
        throw Error(locale.t("Ход для создания ветки не найден."));
      const result = await server.request("thread/fork", {
        threadId: s.id,
        ...(item ? { lastTurnId: item.turnId } : {}),
        cwd: s.cwd || cwd(),
        ephemeral: false,
        excludeTurns: true,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      const name = s.name + locale.t(" — ветка");
      await server.request("thread/name/set", {
        threadId: result.thread.id,
        name,
      });
      const fork = create({
        key: randomUUID(),
        id: result.thread.id,
        name,
        customName: true,
        cwd: result.thread.cwd || s.cwd || cwd(),
        parentId: s.id,
        model: result.model,
        effort: result.reasoningEffort,
        prefs: {
          ...s.prefs,
          access: "workspace",
          mode: "workspace",
          plan: false,
        },
        draft: "",
        attachments: [],
      });
      await library.update(fork, { group: library.get(s).group || "" });
      await save(fork);
      await resume(fork, fork.id);
      publish(fork);
      return fork;
    } else if (msg.action === "continueWindow") {
      await save(s);
      const previous = s.host;
      previous.keys = previous.keys.filter((key) => key !== s.key);
      s.panel = null;
      if (previous.keys.length) {
        if (previous.activeKey === s.key)
          select(sessions.get(previous.keys[0]));
        await saveHost(previous);
        publish(sessions.get(previous.activeKey));
      } else previous.panel.dispose();
      const copy = create(
        store.session(s.key),
        undefined,
        vscode.ViewColumn.Active,
        createHost(undefined, vscode.ViewColumn.Active),
      );
      await vscode.commands.executeCommand(
        "workbench.action.moveEditorToNewWindow",
      );
      return copy;
    } else if (msg.action === "rename") {
      const name = typeof msg.name === "string" ? msg.name.trim() : "";
      if (!name || name.length > 200)
        throw Error(locale.t("Имя должно содержать от 1 до 200 символов."));
      if (s.id) {
        await connect();
        await server.request("thread/name/set", { threadId: s.id, name });
      }
      s.name = name;
      s.customName = true;
      await save(s);
      publish(s);
    } else if (msg.action === "history") {
      const result = await loadHistory(msg);
      await s.panel?.webview.postMessage({
        type: "history",
        key: s.key,
        data: result.rows,
        cursor: result.cursor,
        generation: msg.generation,
        append: !!msg.cursor,
      });
    } else if (msg.action === "open") {
      if (typeof msg.key === "string") openEntry({ key: msg.key, id: msg.id });
      else if (typeof msg.id === "string") openEntry({ id: msg.id });
    } else if (msg.action === "older" && s.cursor) {
      const page = await server.request("thread/items/list", {
        threadId: s.id,
        limit: 200,
        sortDirection: "desc",
        cursor: s.cursor,
      });
      s.items = [
        ...(page.data || []).slice().reverse().map(readItem),
        ...s.items,
      ];
      s.cursor = page.nextCursor;
      publish(s);
    } else if (msg.action === "settings" || msg.action === "defaults") {
      await connect();
      const model = catalog.find(
        (model) => model.model === (msg.model || s.model),
      );
      if (!model)
        throw Error(locale.t("Модель отсутствует в доступном каталоге."));
      const effort =
        msg.effort ||
        model.supportedReasoningEfforts.find(
          (option) => option.reasoningEffort === s.effort,
        )?.reasoningEffort ||
        model.defaultReasoningEffort;
      if (
        !model.supportedReasoningEfforts.some(
          (option) => option.reasoningEffort === effort,
        )
      )
        throw Error(locale.t("Эта модель не поддерживает выбранную глубину."));
      if (msg.action === "defaults") {
        await library.setDefaults({ model: model.model, effort });
        broadcast();
        return;
      }
      if (s.id && !s.busy && !s.followUpSending) {
        if (!s.loaded) await resume(s, s.id);
        await server.request("thread/settings/update", {
          threadId: s.id,
          model: model.model,
          effort,
          serviceTier:s.prefs.fast ? speed.fastTier(model) : null,
        });
      }
      if (effort === "none" && s.effort && s.effort !== "none") {
        s.prefs.previousEfforts = {
          ...s.prefs.previousEfforts,
          [s.model]: s.effort,
        };
      }
      s.model = model.model;
      s.effort = effort;
      if(!speed.fastTier(model))s.prefs.fast=false;
      await save(s);
      publish(s);
    } else if (msg.action === 'fast') {
      if(typeof msg.enabled!=='boolean')return;
      if(s.busy || s.compacting)throw Error(locale.t('Меняйте скорость после завершения текущей задачи.'));
      await connect();
      const tier=speed.fastTier(catalog.find(model=>model.model===s.model));
      if(msg.enabled && !tier)throw Error(locale.t('Fast недоступен для этой модели или аккаунта.'));
      if(s.id){
        if(!s.loaded)await resume(s,s.id);
        await server.request('thread/settings/update',{threadId:s.id,serviceTier:msg.enabled?tier:null});
      }
      s.prefs.fast=msg.enabled;await save(s);publish(s);
    } else if (msg.action === "mode") {
      await setMode(s, msg.mode);
    } else if (msg.action === "ultra") {
      if (typeof msg.enabled !== "boolean") return;
      await connect();
      const model = catalog.find((m) => m.model === s.model),
        options = model?.supportedReasoningEfforts || [];
      if (!options.some((o) => o.reasoningEffort === "ultra"))
        throw Error(locale.t("Эта модель не поддерживает Ultra."));
      const previous = s.effort,
        effort = msg.enabled
          ? "ultra"
          : [
              s.prefs.beforeUltra?.[s.model],
              model.defaultReasoningEffort,
              ...options.map((o) => o.reasoningEffort),
            ].find(
              (e) =>
                e &&
                e !== "ultra" &&
                options.some((o) => o.reasoningEffort === e),
            );
      if (!effort) throw Error(locale.t("Другой уровень глубины недоступен."));
      await handle(s, { action: "settings", effort });
      if (msg.enabled && previous !== "ultra") {
        s.prefs.beforeUltra = { ...s.prefs.beforeUltra, [s.model]: previous };
        await save(s);
      }
    } else if (msg.action === 'contextDisplay') {
      if(!['percent','ring'].includes(msg.value))return;
      await vscode.workspace.getConfiguration('rundix').update('contextDisplay',msg.value,vscode.ConfigurationTarget.Global);
      broadcast();
    } else if (msg.action === 'chatWidth') {
      if(!['wide','compact'].includes(msg.value))return;
      await vscode.workspace.getConfiguration('rundix').update('chatWidth',msg.value,vscode.ConfigurationTarget.Global);
      broadcast();
    } else if (msg.action === "preferences") {
      if (["read", "workspace", "full"].includes(msg.access))
        await setMode(
          s,
          { read: "manual", workspace: "workspace", full: "full" }[msg.access],
        );
      if (typeof msg.plan === "boolean")
        await setMode(s, msg.plan ? "plan" : "workspace");
      for (const key of ["focus", "showThinking", "ide"])
        if (typeof msg[key] === "boolean") s.prefs[key] = msg[key];
      await save(s);
      publish(s);
    } else if (msg.action === 'pasteImage') {
      try {
        if(s.attachments.filter(file=>file.kind==='image').length>=8)throw Error(locale.t('Можно прикрепить до 8 изображений.'));
        const attachment=await savePastedImage(pastedImageRoot,msg.dataUrl);
        s.attachments.push(attachment);await save(s);publish(s);
      } finally {
        void s.host?.panel?.webview.postMessage({type:'pasteImageResult',requestId:msg.requestId});
      }
    } else if (msg.action === "attach") {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: locale.t("Добавить в контекст"),
      });
      for (const uri of files || []) addFile(s, uri);
      await save(s);
      publish(s);
    } else if (msg.action === "compact") {
      if (authBusy) throw Error(locale.t('Дождитесь переключения аккаунта.'));
      if (!s.id || s.busy)
        throw Error(
          locale.t("Сжатие доступно для свободной сохранённой сессии."),
        );
      const accountLease = store.acquire('account-credentials');
      try {
      await connect();
      if (!s.loaded) await resume(s, s.id);
      const release = store.acquire(s.id);
      turnLeases.set(s.id, release);
      s.compacting = true;
      s.busy = true;
      s.turnStartedAt=Date.now();
      s.usageStale = true;
      publish(s);
      try {
        await server.request("thread/compact/start", { threadId: s.id });
      } catch (error) {
        release();
        turnLeases.delete(s.id);
        s.compacting = false;
        s.busy = false;
        throw error;
      } finally {
        publish(s);
      }
      } finally { accountLease(); }
    } else if (msg.action === "removeAttachment") {
      s.attachments = s.attachments.filter((file) =>
        msg.id ? file.id !== msg.id : file.path !== msg.path,
      );
      await save(s);
      publish(s);
    } else if (msg.action === "reopen") await reopenClosed();
    else if (msg.action === "openLast") await openLast();
    else if (msg.action === "beside")
      create(undefined, undefined, vscode.ViewColumn.Beside);
    else if (msg.action === "newWindow") {
      create(
        undefined,
        undefined,
        vscode.ViewColumn.Active,
        createHost(undefined, vscode.ViewColumn.Active),
      );
      await vscode.commands.executeCommand(
        "workbench.action.moveEditorToNewWindow",
      );
    } else if (msg.action === "group") {
      const name = typeof msg.name === "string" ? msg.name.trim() : "";
      if (name.length > 100)
        throw Error(locale.t("Название группы слишком длинное."));
      await library.update(s, { group: name });
      broadcast();
    } else if (msg.action === "unread") {
      await library.update(s, { unread: true });
      broadcast();
    } else if (msg.action === "bookmark") {
      if (typeof msg.enabled !== "boolean" || typeof msg.itemId !== "string")
        return;
      const item = s.items.find(
        (item) =>
          item.id === msg.itemId && item.type === "agentMessage" && item.text,
      );
      if (msg.enabled && (!item || s.busy))
        throw Error(
          locale.t("Закладку можно добавить после завершения ответа."),
        );
      if (
        !msg.enabled &&
        !library.bookmarks(s).some((item) => item.id === msg.itemId)
      )
        return;
      await library.setBookmark(s, item || { id: msg.itemId }, msg.enabled);
      broadcast();
    } else if (
      ["bookmarkRead", "copyBookmark", "revealBookmark"].includes(msg.action)
    ) {
      const bookmark = library
        .bookmarks(s)
        .find((item) => item.id === msg.itemId);
      if (!bookmark) throw Error(locale.t("Закладка не найдена."));
      if (msg.action === "bookmarkRead")
        await s.panel?.webview.postMessage({
          type: "bookmarkDetails",
          key: s.key,
          bookmark,
        });
      else if (msg.action === "copyBookmark")
        await vscode.env.clipboard.writeText(bookmark.text);
      else {
        await connect();
        if (s.id && !s.loaded) await resume(s, s.id);
        let pages = 0;
        while (
          !s.items.some((item) => item.id === bookmark.id) &&
          s.cursor &&
          pages++ < 40
        ) {
          const page = await server.request("thread/items/list", {
            threadId: s.id,
            limit: 200,
            sortDirection: "desc",
            cursor: s.cursor,
          });
          s.items = [
            ...(page.data || []).slice().reverse().map(readItem),
            ...s.items,
          ];
          s.cursor = page.nextCursor;
        }
        if (!s.items.some((item) => item.id === bookmark.id))
          throw Error(
            locale.t(
              "Ответ не найден в истории. Сохранённый текст доступен в закладках.",
            ),
          );
        publish(s);
        await s.panel?.webview.postMessage({
          type: "revealItem",
          key: s.key,
          itemId: bookmark.id,
        });
      }
    } else if (msg.action === "skills") {
      await connect();
      const result = await server.request("skills/list", {
        cwds: s.cwd || cwd() ? [s.cwd || cwd()] : [],
        forceReload: !!msg.forceReload,
      });
      const skills = result.data
        .flatMap((entry) => entry.skills)
        .filter((skill) => skill.enabled);
      s.skillCandidates = new Map();
      const rows = skills.map((skill) => {
        const id = randomUUID();
        s.skillCandidates.set(id, skill);
        return {
          id,
          name: skill.interface?.displayName || skill.name,
          description:
            skill.interface?.shortDescription ||
            skill.shortDescription ||
            skill.description,
        };
      });
      await s.panel?.webview.postMessage({
        type: "skills",
        key: s.key,
        generation: msg.generation,
        skills: rows,
        errors: result.data.flatMap((entry) => entry.errors).length,
      });
    } else if (msg.action === "attachSkill") {
      const skill = s.skillCandidates?.get(msg.id);
      if (!skill)
        throw Error(locale.t("Выберите навык из актуального списка Codex."));
      if (
        !s.attachments.some(
          (item) => item.kind === "skill" && item.path === skill.path,
        )
      )
        s.attachments.push({
          id: randomUUID(),
          kind: "skill",
          skillName: skill.name,
          name: skill.interface?.displayName || skill.name,
          path: skill.path,
        });
      await save(s);
      publish(s);
    } else if (msg.action === "selection") await addSelection(s);
    else if (msg.action === "projectFiles") {
      const result = await projectFiles.search(
        s.cwd || cwd(),
        typeof msg.query === "string" ? msg.query : "",
      );
      s.fileCandidates ||= new Map();
      if (s.fileCandidates.size > 1000) s.fileCandidates.clear();
      const files = result.files.map((file) => {
        const id = randomUUID();
        s.fileCandidates.set(id, file.path);
        return { id, name: file.relative };
      });
      await s.panel?.webview.postMessage({
        type: "projectFiles",
        key: s.key,
        generation: msg.generation,
        files,
        truncated: result.truncated,
      });
    } else if (msg.action === "attachProjectFile") {
      const file = s.fileCandidates?.get(msg.id);
      if (!file)
        throw Error(locale.t("Выберите файл из актуального списка проекта."));
      addFile(s, vscode.Uri.file(file));
      await save(s);
      publish(s);
    } else if (msg.action === "copyItem") {
      await vscode.env.clipboard.writeText(
        copyText(s.items, msg.itemId, msg.codeIndex),
      );
      await s.panel?.webview.postMessage({
        type: "copied",
        key: s.key,
        itemId: msg.itemId,
        codeIndex: msg.codeIndex,
      });
    } else if (msg.action === "diff") {
      const change = s.items.find(
        (item) => item.id === msg.itemId && item.type === "fileChange",
      )?.changes?.[msg.index];
      if (!change || typeof change.path !== "string")
        throw Error(locale.t("Изменение файла не найдено."));
      const file = vscode.Uri.file(
        path.resolve(s.cwd || cwd() || "", change.path),
      );
      let current = "";
      try {
        current = (await vscode.workspace.openTextDocument(file)).getText();
      } catch {}
      const pair = versions(current, change.diff || "");
      if (!pair) {
        const doc = await vscode.workspace.openTextDocument({
          language: "diff",
          content:
            change.diff || locale.t("Нет текстового diff для этого изменения."),
        });
        await vscode.window.showTextDocument(doc, { preview: false });
        return;
      }
      const key = randomUUID(),
        before = vscode.Uri.parse(
          `rundix-diff:/${key}/before/${encodeURIComponent(path.basename(change.path))}`,
        ),
        after = vscode.Uri.parse(
          `rundix-diff:/${key}/after/${encodeURIComponent(path.basename(change.path))}`,
        );
      virtualDocuments.set(before.toString(), pair.before);
      virtualDocuments.set(after.toString(), pair.after);
      await vscode.commands.executeCommand(
        "vscode.diff",
        before,
        after,
        path.basename(change.path) + " · Rundix",
        { preview: false },
      );
    } else if (msg.action === "answer") {
      const request = pendingRequests.get(String(msg.id));
      if (
        !request ||
        (request.params.threadId && request.params.threadId !== s.id)
      )
        return;
      let result;
      if (request.method === "item/tool/requestUserInput") {
        const entries = (request.params.questions || []).map(question => {
          if(msg.skip===true)return [question.id,{answers:[]}];
          const answer = msg.answers?.[question.id];
          if (typeof answer !== "string" || !answer.trim() || answer.length>20000)
            throw Error(locale.t("Ответьте на все вопросы."));
          return [question.id,{answers:[answer]}];
        });
        result = {answers:Object.fromEntries(entries)};
        if(preflight.preparing(s.preflight))s.preflight.skipped=msg.skip===true;
      } else if (request.method === "item/permissions/requestApproval") {
        if (!["accept", "decline"].includes(msg.decision)) return;
        result = {
          permissions:
            msg.decision === "accept" ? request.params.permissions : {},
          scope: "turn",
        };
      } else if (request.method === "mcpServer/elicitation/request") {
        if (!["accept", "decline", "cancel"].includes(msg.decision)) return;
        if (msg.decision === "accept" && request.params.mode === "form")
          result = {
            action: "accept",
            content: forms.validate(
              request.params.requestedSchema,
              msg.content,
            ),
          };
        else if (msg.decision === "accept" && request.params.mode === "url")
          result = { action: "accept", content: null };
        else if (msg.decision === "accept")
          throw Error(
            locale.t("Этот тип подтверждения пока не поддерживается."),
          );
        else result = { action: msg.decision, content: null };
      } else {
        if (
          !["accept", "acceptForSession", "decline", "cancel"].includes(
            msg.decision,
          )
        )
          return;
        if (
          request.params.availableDecisions &&
          !request.params.availableDecisions.includes(msg.decision)
        )
          throw Error(locale.t("Это решение недоступно для данного запроса."));
        result = { decision: msg.decision };
      }
      server.respond(request.id, result);
      pendingRequests.delete(String(msg.id));
      if(request.method==='item/tool/requestUserInput'){
        questionRecords.remember(s,{id:'b:'+(request.params.itemId || request.id),origin:'blocking',parentItemId:request.params.itemId || null,
          questions:request.params.questions || [],answers:msg.answers,skipped:msg.skip===true});
        await save(s);
      }
      broadcast();
    } else if (msg.action === "openReference") {
      const target = reference(s.items, msg.itemId, msg.href, s.cwd || cwd());
      if (target.url)
        await vscode.env.openExternal(vscode.Uri.parse(target.url));
      else {
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.file(target.path),
        );
        const line = Math.min(document.lineCount - 1, target.line - 1);
        await vscode.window.showTextDocument(document, {
          preview: true,
          selection: new vscode.Range(line, 0, line, 0),
        });
      }
    } else if (msg.action === "requestUrl") {
      const request = pendingRequests.get(String(msg.id));
      if (
        !request ||
        (request.params.threadId && request.params.threadId !== s.id) ||
        request.params.mode !== "url"
      )
        return;
      const url = new URL(request.params.url);
      if (!["http:", "https:"].includes(url.protocol))
        throw Error(locale.t("Неподдерживаемый адрес."));
      await vscode.env.openExternal(vscode.Uri.parse(url.href));
    } else if (msg.action === 'connectionSettings') {
      await chooseConnection();
    } else if (msg.action === 'accountRefresh') {
      await refreshAccountStatus();
      publish(s);
    } else if (msg.action === "accountCancel") {
      await pendingLogin.cancel();
    } else if (msg.action === "account") {
      if (connections.selection().id !== 'local') return chooseConnection();
      if ([...sessions.values()].some((session) => session.busy))
        throw Error(
          locale.t("Дождитесь завершения задач перед сменой аккаунта."),
        );
      await withLocalSignIn(async release => {
        await connect();
        await refreshAccount();
        for (const session of sessions.values()) await save(session);
        const record = pendingLogin.begin(server, release);
        try {
          await startLogin(record.client, {
            onStarted: id => {
              if (pendingLogin.current !== record) throw Error('Browser sign-in expired. Please try again.');
              if (!id) throw Error('CLI did not return a login identifier.');
              record.id = loginId = id;
              const completion = record.completions?.find(message => message.params.loginId === id);
              if (completion) record.client.emit('notification', completion);
            },
            openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
          });
        } catch (error) {
          await pendingLogin.cancel(record).catch(() => {});
          throw error;
        }
        broadcast();
      });
    } else if (msg.action === "retry") {
      if(authBusy)throw Error(locale.t('Дождитесь переключения аккаунта.'));
      if ([...sessions.values()].some(session => session.busy || session.compacting))
        throw Error(locale.t('Дождитесь завершения задач перед переподключением.'));
      connecting = null;
      server?.dispose();
      await connect();
      if (s.id) {
        s.loaded = false;
        await resume(s, s.id);
      }
      s.error = null;
      publish(s);
    }
  }
  function target(item) {
    if (item?.key || item?.id)
      return (
        [...sessions.values()].find((s) =>
          item.key ? s.key === item.key : s.id === item.id,
        ) || item
      );
    return (
      [...sessions.values()].find(isActive) ||
      sessions.get(lastHost?.activeKey) ||
      sessions.get(library.last?.key)
    );
  }
  function openEntry(entry) {
    const existing = [...sessions.values()].find(
      (s) => s.panel && (entry.key ? s.key === entry.key : s.id === entry.id),
    );
    if (existing) return select(existing);
    const saved =
      store.session(
        entry.key ||
          store.list().find((row) => row.id === entry.id)?.key ||
          "missing",
      ) || context.workspaceState.get("session:" + entry.key);
    const column = vscode.window.tabGroups.all.some(
      (g) => g.viewColumn === entry.column,
    )
      ? entry.column
      : vscode.ViewColumn.Active;
    return create(
      saved || { ...entry, key: entry.key || randomUUID() },
      undefined,
      column,
    );
  }
  function openLast() {
    const active = target();
    return active?.panel
      ? select(active)
      : library.last
        ? openEntry(library.last)
        : create();
  }
  function reopenClosed() {
    reopenQueue = reopenQueue
      .catch(() => {})
      .then(async () => {
        while (library.closed.length) {
          const entry = await library.pop();
          void vscode.commands.executeCommand(
            "setContext",
            "rundix.hasClosed",
            library.closed.length > 0,
          );
          if (
            [...sessions.values()].some(
              (s) =>
                s.panel &&
                (s.key === entry.key || (entry.id && s.id === entry.id)),
            )
          )
            continue;
          return openEntry(entry);
        }
        return vscode.commands.executeCommand(
          "workbench.action.reopenClosedEditor",
        );
      });
    return reopenQueue;
  }
  function localRows() {
    return [...sessions.values()]
      .filter((s) => s.panel)
      .map((s) => ({
        key: s.key,
        id: s.id,
        name: s.name,
        cwd: s.cwd,
        parentId: s.parentId,
        open: true,
        busy: s.busy,
      }));
  }
  function mergeRows(rows, query = "", scope = "workspace") {
    const result = [],
      seen = new Set();
    for (const row of [
      ...localRows(),
      ...store
        .list(scope === "workspace" ? cwd() : undefined)
        .map((row) => ({
          key: row.key,
          id: row.id,
          name: row.name,
          cwd: row.cwd,
          parentId: row.parentId,
          local: true,
        })),
      ...rows,
      ...library.closed
        .filter((entry) => !entry.id)
        .map((entry) => ({ ...entry, closed: true })),
    ]) {
      const id = row.id || row.key;
      if (
        seen.has(id) ||
        !row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())
      )
        continue;
      seen.add(id);
      result.push(row);
    }
    return library.decorate(result);
  }
  async function loadHistory(options = {}) {
    await connect();
    const scope =
      options.scope ||
      vscode.workspace
        .getConfiguration("rundix")
        .get("historyScope", "workspace");
    const query =
      typeof options.query === "string" ? options.query.slice(0, 200) : "";
    const result = await server.request("thread/list", {
      limit: 100,
      ...(scope === "workspace" && cwd() ? { cwd: cwd() } : {}),
      archived: false,
      modelProviders: [],
      sortKey: "updated_at",
      ...(query ? { searchTerm: query } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    const rows = result.data.map((t) => ({
      id: t.id,
      name: t.name || t.preview || "Rundix",
      cwd: t.cwd,
      parentId: t.forkedFromId,
    }));
    if (!query) {
      historyLoaded = true;
      recent = options.cursor ? [...recent, ...rows] : rows;
      treeEvents.fire();
    }
    return { rows: mergeRows(rows, query, scope), cursor: result.nextCursor };
  }
  function addFile(s, uri) {
    const file = fileAttachment(uri);
    if (file && !s.attachments.some(a => a.path === file.path && a.kind !== 'selection')) s.attachments.push(file);
  }
  async function addSelection(s) {
    if (!lastEditor || lastEditor.selection.isEmpty)
      throw Error(locale.t("Сначала выделите код в редакторе."));
    const text = lastEditor.document.getText(lastEditor.selection);
    if (text.length > 200000)
      throw Error(locale.t("Выделение превышает 200 000 символов."));
    s.attachments.push({
      id: randomUUID(),
      kind: "selection",
      path: lastEditor.document.uri.fsPath,
      name: `${path.basename(lastEditor.document.uri.fsPath)}:${lastEditor.selection.start.line + 1}–${lastEditor.selection.end.line + 1}`,
      text,
    });
    await save(s);
    publish(s);
  }
  const tree = {
    onDidChangeTreeData: treeEvents.event,
    async getChildren(group) {
      if (group) return group.children;
      if (!historyLoaded) await loadHistory();
      const groups = new Map();
      for (const row of mergeRows(recent)) {
        const label =
          row.group || (row.open ? locale.t("Открытые") : locale.t("Недавние"));
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(row);
      }
      return [...groups].map(([name, children]) => ({ name, children }));
    },
    getTreeItem(row) {
      const item = new vscode.TreeItem(
        (row.unread ? "● " : "") + row.name,
        row.children
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
      if (row.children) {
        item.id = "group:" + row.name;
        return item;
      }
      item.id = row.id || row.key;
      item.contextValue = "rundixSession";
      item.description = row.busy
        ? locale.t("Выполняется")
        : row.open
          ? locale.t("Открыта")
          : "";
      item.iconPath = new vscode.ThemeIcon(
        row.busy
          ? "sync~spin"
          : row.unread
            ? "circle-filled"
            : "comment-discussion",
      );
      item.command = {
        command: "rundix.openSession",
        title: locale.t("Открыть сессию"),
        arguments: [row],
      };
      return item;
    },
  };
  context.subscriptions.push(
    vscode.window.createTreeView("rundix.sessions", {
      treeDataProvider: tree,
      showCollapseAll: true,
    }),
  );
  const commands = {
    new: () => create(),
    close: () => {
      const s = target();
      if (s?.panel) return closeTab(s);
    },
    openLast,
    reopen: reopenClosed,
    beside: () => create(undefined, undefined, vscode.ViewColumn.Beside),
    newWindow: async () => {
      const s = create(
        undefined,
        undefined,
        vscode.ViewColumn.Active,
        createHost(undefined, vscode.ViewColumn.Active),
      );
      await vscode.commands.executeCommand(
        "workbench.action.moveEditorToNewWindow",
      );
      return s;
    },
    openSession: (row) => openEntry(row),
    switch: () => {
      const s = target() || create();
      void s.panel.webview.postMessage({ type: "open", action: "history" });
    },
    rename: async (item) => {
      const s = target(item);
      if (s) {
        const open = s.panel ? s : openEntry(s);
        const name=await vscode.window.showInputBox({title:locale.t('Переименовать вкладку'),value:open.name,ignoreFocusOut:true,
          validateInput:value=>value.trim() && value.trim().length<=200?null:locale.t('Имя должно содержать от 1 до 200 символов.')});
        if(name!==undefined)await handle(open,{action:'rename',name});
      }
    },
    group: (item) => {
      const s = target(item);
      if (s) {
        const open = s.panel ? select(s) : openEntry(s);
        void open.panel.webview.postMessage({ type: "open", action: "group" });
      }
    },
    unread: async (item) => {
      const s = target(item);
      if (s) {
        await library.update(s, { unread: true });
        broadcast();
      }
    },
    selection: async () => {
      const s = target() || openLast();
      await addSelection(s);
    },
    addFile: async (uri) => {
      const s = target() || openLast();
      if (uri) addFile(s, uri);
      else
        for (const file of (await vscode.window.showOpenDialog({
          canSelectMany: true,
        })) || [])
          addFile(s, file);
      await save(s);
      publish(s);
    },
    refresh: async () => {
      await loadHistory();
      treeEvents.fire();
    },
    logs: () => output.show(),
    notifications: () => notificationSettings.configure(),
  };
  for (const [name, action] of Object.entries(commands))
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "rundix." + name,
        async (...args) => {
          try {
            return await action(...args);
          } catch (error) {
            const s = target();
            if (s) {
              s.error = error.message;
              publish(s);
            } else void vscode.window.showErrorMessage(error.message);
          }
        },
      ),
    );
  async function restoreHost(panel, state) {
    const saved =
      state?.hostKey &&
      (store.host(state.hostKey) ||
        context.workspaceState.get("host:" + state.hostKey));
    const keys = saved?.keys || [],
      activeKey = keys.includes(state?.key)
        ? state.key
        : keys.includes(saved?.activeKey)
          ? saved.activeKey
          : keys[0];
    const record =
      activeKey &&
      (store.session(activeKey) ||
        context.workspaceState.get("session:" + activeKey));
    const host = createHost(panel, vscode.ViewColumn.Active, saved?.hostKey);
    create(
      record || context.workspaceState.get("session:" + state?.key) || state,
      panel,
      vscode.ViewColumn.Active,
      host,
    );
    for (const key of keys) {
      if (key === activeKey || sessions.get(key)?.panel) continue;
      const session =
        store.session(key) || context.workspaceState.get("session:" + key);
      if (session)
        create(
          session,
          undefined,
          {
            viewColumn: panel.viewColumn || vscode.ViewColumn.Active,
            preserveFocus: true,
          },
          undefined,
          false,
        );
    }
    if (keys.length > 1) {
      host.panel.reveal(host.panel.viewColumn, true);
      select(sessions.get(host.activeKey), false);
    }
    return host;
  }

  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("rundix.session", {
      async deserializeWebviewPanel(panel, state) {
        await restoreHost(panel, state);
      },
    }),
  );
  context.subscriptions.push({
    dispose() {
      disposed=true;clearInterval(maintenanceTimer);
      server?.dispose(); pendingLogin.finish();
      mcpTasks?.dispose();mcpBridge?.dispose();mcpLease?.();
    },
  });
  let lastCliCheck=0;
  const maintenanceTimer=setInterval(()=>{
    if(disposed||!server?.child)return;
    if(Date.now()-lastCliCheck>=3600000 || cliInfo.phase==='pending') {
      lastCliCheck=Date.now();void checkCliUpdates();
    }
    if(Date.now()-catalogUpdatedAt>=300000)void refreshCatalog().catch(()=>{});
  },60000);
  return {
    connections: {
      version: 1,
      registerProvider(owner, provider) { const subscription = connections.register(owner, provider); broadcast(); return subscription; },
      configure: configureConnection,
      useLocal: () => configureConnection('local'),
      importHistory(owner, snapshot) {
        if (![...connections.providers.values()].some(entry => entry.owner === owner)) throw Error('History source extension is not registered.');
        return withLocalSignIn(async () => {
          const result=require('./runtime/connection-history.cjs').copyHistory(store,snapshot);
          treeEvents.fire();broadcast();return result;
        });
      },
    },
    mcp:{start:startMcp,stop:stopMcp,tasks:()=>mcpTasks,connectPool:connectMcpPool,panelSnapshot:mcpPanelSnapshot,panelAction:handleMcpPanel,openPanel:openMcpEditor},
    create,
    connect,
    sessions,
    hosts,
    server: () => server,
    handle,
    library,
    store,
    reopenClosed,
    openLast,
    loadHistory,
    tree,
    addSelection,
    select,
    closeTab,
    restoreHost,
    dispatch,
    checkCliUpdates,
    refreshCatalog,
  };
}
module.exports = { activate };
