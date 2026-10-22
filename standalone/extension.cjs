const { findCli } = require('./runtime/transport.cjs');
const { createSessionCore } = require('./runtime/session-core.cjs');
const composerDraft = require('./runtime/composer-draft.cjs');
const locale = require("./ui/i18n.js");
// Independent implementation using the documented Codex App Server protocol.
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");
const { CliUpdates } = require('./runtime/cli-updates.cjs');
const { savePastedImage } = require('./runtime/pasted-image.cjs');
const { messageImages } = require('./runtime/message-images.cjs');
const {
  itemText,
  readItem,
  copyText,
} = require("./runtime/session.cjs");
const { newSessionSettings } = require('./runtime/new-session-settings.cjs');
const { canEditQueued, queuedEdit, selectedAttachments, assertQueueCurrent, moveQueued } = require('./runtime/queued-edits.cjs');
const { fileAttachment, stageQueuedAttachments } = require('./runtime/queued-attachments.cjs');
const { transferQueuedSession, acquireQueuedSession } = require('./runtime/queued-session-transfer.cjs');
const { startLogin } = require("./runtime/account.cjs");
const { createMcpHost } = require('./runtime/mcp-host.cjs');
const { reportMarkdown: mcpReportMarkdown } = require('./runtime/mcp-executor.cjs');
const {activateCompanions}=require('./runtime/connection-companions.cjs');
const mcpPanelState=require('./runtime/mcp-panel.cjs');
const { ProjectFiles } = require("./runtime/files.cjs");
const modes = require("./ui/modes.js");
const speed = require('./ui/speed.js');
const { versions } = require("./runtime/diff.cjs");
const asyncQuestions = require('./runtime/async-questions.cjs');
const preflight = require('./runtime/task-preflight.cjs');
const { reference } = require("./runtime/references.cjs");
const { tabTitle } = require("./runtime/titles.cjs");
const { CompletionNotifications } = require('./runtime/completion-notifications.cjs');
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
  const hosts = new Map();
  const sessionViews = new WeakMap();
  const view = s => s && sessionViews.get(s) || {};
  const hasChat = s => !!view(s)?.panel;
  let lastHost, lastEditor = vscode.window.activeTextEditor;
  const pastedImageRoot=path.join(context.globalStorageUri.fsPath,'pasted-images');
  const cliUpdates = new CliUpdates({root:path.join(context.globalStorageUri.fsPath,'cli')});
  let cliOverride = null, cliCheckRequest = null;
  let cliInfo = {version:null,phase:'idle',error:false,managed:false};
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
  const core = createSessionCore({
    paths: { storage: context.globalStorageUri.fsPath },
    settings: (key, fallback, scope) => {
      const config = vscode.workspace.getConfiguration('rundix');
      return scope === 'user' ? config.inspect(key)?.globalValue : config.get(key, fallback);
    },
    workspaceState: {
      get: (...args) => context.workspaceState.get(...args),
      update: (...args) => context.workspaceState.update(...args),
    },
    trusted: () => vscode.workspace.isTrusted,
    logger: message => output.appendLine(message),
    clock: { now: () => Date.now(), setTimeout, clearTimeout },
    events: {
      changed: () => broadcast(), sessionChanged: s => publish(s),
      treeChanged: () => treeEvents.fire(),
      notify: message => { void vscode.window.showWarningMessage(message); },
      completed: completion => completionNotifications.dispatch(completion),
    },
    hasChat, isActive: s => isActive(s), activeSession: () => target(),
    openChat: s => select(s), loadSelected: s => loadSelected(s),
    defaultDirectory: () => cwd(),
    editorSelection: () => lastEditor?.document.uri.scheme === 'file'
      ? { path: lastEditor.document.uri.fsPath, text: lastEditor.document.getText(lastEditor.selection).slice(0, 20000) } : null,
    activateConnectionOwner: async owner => {
      const extension = vscode.extensions.getExtension(owner);
      if (!extension) throw Error('The selected connection extension is not installed.');
      await extension.activate();
    },
    resolveCli: () => resolveCli(), checkCliUpdates: () => checkCliUpdates(),
    cliCheckPending: () => !!cliCheckRequest,
    acceptCli: prepared => cliUpdates.accept(prepared.channel, prepared),
    clearProjectFiles: () => projectFiles.clear(),
    applyPendingMode: s => applyPendingMode(s),
    taskSessions: () => mcpHost.tasks && ({
      tasks: { values: () => mcpHost.tasks.tasks.values() },
      adapter: { pending: task => mcpHost.tasks.adapter.pending(task) },
      call: (...args) => mcpHost.tasks.call(...args),
    }),
  });
  const { sessions, store, library, connections, pendingLogin, pendingRequests, turnLeases } = core;
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
  const mcpViews=new Map();
  const serviceChats=new Map();
  const serviceChatKey=(spaceId,taskId)=>JSON.stringify([spaceId,taskId]);
  function postServiceChat(record,data) {
    record.snapshot=data;
    record.draftState=context.workspaceState.get('service-chat:'+serviceChatKey(record.spaceId,record.taskId),null);
    return record.panel.webview.postMessage({type:'serviceChat',data:data?{...data,language:locale.language,
      draftState:record.draftState}:null});
  }
  function refreshServiceChat(record,client=serviceClient) {
    record.dirty=true;
    if(record.read)return record.read;
    const peer=client?.peer;
    const current=()=>!record.disposed && client===serviceClient && vscode.workspace.isTrusted && peer && client.peer===peer;
    record.read=(async()=>{
      do {
        record.dirty=false;
        if(!current()){await postServiceChat(record,null);return;}
        const snapshot=await client.chat(record.spaceId,'chat.subscribe',{taskId:record.taskId});
        if(current())await postServiceChat(record,snapshot);
      }while(record.dirty && current());
    })().catch(()=>{if(!record.disposed && client===serviceClient)void postServiceChat(record,null);}).finally(()=>{
      record.read=null;if(record.dirty && !record.disposed && serviceClient?.peer)void refreshServiceChat(record);
    });
    return record.read;
  }
  async function serviceChatAction(record,message) {
    if(!message || record.disposed)throw Error('Task chat closed.');
    const draftKey='service-chat:'+serviceChatKey(record.spaceId,record.taskId);
    if(['draft','closeReady'].includes(message.action)){
      if(!message.state || Buffer.byteLength(JSON.stringify(message.state))>2*1024*1024)throw Error('Draft is too large.');
      record.draftWrite=(record.draftWrite || Promise.resolve()).catch(()=>{}).then(()=>context.workspaceState.update(draftKey,message.state));
      await record.draftWrite;if(message.action==='closeReady')record.panel.dispose();return;
    }
    if(!vscode.workspace.isTrusted)throw Object.assign(Error('Workspace trust is required.'),{code:'workspace_untrusted'});
    if(message.action==='ready' || message.action==='refresh'){await refreshServiceChat(record);return;}
    const client=serviceClient;
    if(!client?.spaces.some(space=>space.spaceId===record.spaceId))throw Object.assign(Error('Service is unavailable.'),{code:'service_unavailable'});
    if(message.action==='copyText'){
      if(typeof message.text!=='string' || Buffer.byteLength(message.text)>16384)throw Error('Invalid display text');
      await vscode.env.clipboard.writeText(message.text);return;
    }
    if(message.action==='openReference'){
      const url=new URL(message.href);if(!['https:','http:'].includes(url.protocol))throw Error('Unsupported link');
      await vscode.env.openExternal(vscode.Uri.parse(url.href));return;
    }
    if(message.action==='older'){
      const result=await client.chat(record.spaceId,'chat.history',{taskId:record.taskId,cursor:message.cursor});
      if(client===serviceClient && !record.disposed)await record.panel.webview.postMessage({type:'chatHistory',data:result});return;
    }
    if(!['continue','answer','cancel'].includes(message.action) || typeof message.requestId!=='string' || !/^[\w-]{1,128}$/.test(message.requestId))throw Error('Invalid task chat action.');
    await client.call(record.spaceId,message.action==='cancel'?'cancel_task':'continue_task',{taskId:record.taskId,requestId:message.requestId,
      ...(message.action==='continue'?{clarification:message.text}:message.action==='answer'?{approval:message.approval}:{})});
  }
  function attachServiceChat(panel,spaceId,taskId) {
    const key=serviceChatKey(spaceId,taskId),record={panel,spaceId,taskId};serviceChats.set(key,record);
    panel.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'ui')]};
    panel.iconPath=vscode.Uri.joinPath(context.extensionUri,'resources','extension-icon.png');
    const nonce=randomBytes(18).toString('base64'),uri=file=>panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'ui',file));
    const scripts=['translations.js','i18n.js','forms.js','questions.js','markdown.js','markdown-view.js','task-report.js','service-chat.js'];
    panel.webview.html=`<!doctype html><html lang="${locale.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${uri('mcp-panel.css')}"><link rel="stylesheet" href="${uri('service-chat.css')}"></head><body><main id="app"></main>${scripts.map(file=>`<script nonce="${nonce}" src="${uri(file)}"></script>`).join('')}</body></html>`;
    panel.webview.onDidReceiveMessage(async message=>{
      try{await serviceChatAction(record,message);await panel.webview.postMessage({type:'chatResult',ok:true,action:message.action,requestId:message.requestId});}
      catch{await panel.webview.postMessage({type:'chatResult',ok:false,action:message?.action,requestId:message?.requestId});}
    });
    panel.onDidDispose(()=>{
      record.disposed=true;serviceChats.delete(key);
      if(serviceClient?.peer)void serviceClient.chat(spaceId,'chat.unsubscribe',{taskId}).catch(()=>{});
    });
    return record;
  }
  async function openServiceChat(spaceId,taskId) {
    const client=serviceClient;
    if(!client?.peer?.binding.capabilities.includes('taskChat.v1'))throw Object.assign(Error('Restart the idle service to enable task chats.'),{code:'service_upgrade_required'});
    const snapshot=await client.chat(spaceId,'chat.open',{taskId});
    if(client!==serviceClient || !vscode.workspace.isTrusted)throw Error('Window binding changed.');
    const key=serviceChatKey(spaceId,taskId),existing=serviceChats.get(key);
    if(existing){existing.panel.reveal();await postServiceChat(existing,snapshot);return;}
    const panel=vscode.window.createWebviewPanel('rundix.serviceTask',tabTitle(snapshot.title),vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});
    const record=attachServiceChat(panel,spaceId,taskId);await postServiceChat(record,snapshot);
  }
  // Global user setting only. An activation owns one mode; changes apply on reload.
  const serviceMode=vscode.workspace.getConfiguration('rundix').inspect('mcpService')?.globalValue==='service';
  let serviceInstallation=null;
  let serviceClient=null, serviceStarting=null, serviceStartingEpoch=null, serviceSpaceId=null, serviceError=null, serviceDisposed=false, serviceEpoch=0;
  let serviceStopped=serviceMode && context.globalState.get('mcpServiceStopped',false);
  let serviceWanted=serviceMode && !serviceStopped && context.globalState.get('mcpEnabled',false);
  function closeServiceClient() {
    serviceEpoch++;
    const client=serviceClient;serviceClient=null;client?.close();serviceSpaceId=null;
    for(const record of serviceChats.values())void postServiceChat(record,null);
    publishMcpPanel(true);broadcast();
  }
  async function connectServiceWindow() {
    if(serviceDisposed || !vscode.workspace.isTrusted)throw Object.assign(Error('Workspace trust is required.'),{code:'workspace_untrusted'});
    if(!serviceClient) {
      const client=new (require('./runtime/service-window-client.cjs').ServiceWindowClient)({root:serviceInstallation.root,
        legacyRoot:context.globalStorageUri.fsPath,trusted:true,workspaceFolders:(vscode.workspace.workspaceFolders || []).map(folder=>folder.uri.toString())});
      serviceClient=client;
      const folder=lastEditor && vscode.workspace.getWorkspaceFolder(lastEditor.document.uri);
      if(folder)try{serviceSpaceId=require('./runtime/service-space.cjs').resolveSpace(folder.uri.fsPath).spaceId;}catch{}
      client.on('changed',()=>{if(serviceClient===client)publishMcpPanel();});
      client.on('status',status=>{if(serviceClient===client){serviceError=status==='connected'?null:'service_unavailable';publishMcpPanel(true);broadcast();}});
      client.on('chatChanged',event=>{const record=serviceChats.get(serviceChatKey(event.spaceId,event.taskId));if(record)void refreshServiceChat(record,client);});
      client.on('status',status=>{if(serviceClient===client)for(const record of serviceChats.values()){
        if(status==='connected')void refreshServiceChat(record,client);else void postServiceChat(record,null);
      }});
    }
    const client=serviceClient;await client.start();
    if(serviceDisposed || client!==serviceClient || !vscode.workspace.isTrusted)throw Object.assign(Error('Window binding changed.'),{code:'stale_instance'});
    serviceError=null;
  }
  if(serviceMode)context.subscriptions.push({dispose(){serviceDisposed=true;serviceWanted=false;closeServiceClient();}},
    vscode.workspace.onDidChangeWorkspaceFolders(()=>{
      const pending=serviceStarting || Promise.resolve();
      closeServiceClient();
      const epoch=serviceEpoch;
      if(serviceWanted && !serviceStopped)void pending.catch(()=>{}).then(()=>{
        if(serviceWanted && !serviceStopped && !serviceDisposed && epoch===serviceEpoch)return startMcp();
      }).catch(()=>{});
    }),vscode.workspace.onDidGrantWorkspaceTrust(()=>{if(serviceWanted && !serviceStopped)void startMcp().catch(()=>{});}));
  let serviceSettingsWrite=Promise.resolve();
  function syncServiceSettings() {
    const settings=require('./runtime/service-settings.cjs');
    const config=vscode.workspace.getConfiguration('rundix');
    const snapshot=Object.fromEntries(settings.KEYS.map(key=>[key,{globalValue:config.inspect(key)?.globalValue}]));
    serviceSettingsWrite=serviceSettingsWrite.catch(()=>{}).then(()=>settings.writeServiceSettings(
      serviceInstallation?.root || require('./runtime/service-endpoint.cjs').locations().directory,key=>snapshot[key]));
    return serviceSettingsWrite;
  }
  if(serviceMode)context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event=>{
    if(require('./runtime/service-settings.cjs').KEYS.some(key=>event.affectsConfiguration('rundix.'+key)))
      void syncServiceSettings().catch(()=>vscode.window.showErrorMessage('Background service settings could not be saved. Start MCP again before submitting tasks.'));
  }));
  let mcpEditor=null, mcpPanelBusy=false;
  const mcpRecords=()=>serviceMode?[]:mcpHost.tasks?[...mcpHost.tasks.tasks.values()]:mcpPanelState.readRecords(path.join(context.globalStorageUri.fsPath,'mcp','tasks'));
  async function connectMcpPool() {
    if(serviceMode)throw Object.assign(Error('Configure the installed background service provider.'),{code:'unsupported'});
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
    if(!core.state.account || core.state.limits.error)throw Error('The selected pool connection is unavailable.');
  }
  function mcpPanelSnapshot() {
    if(serviceMode){
      if(!vscode.workspace.isTrusted && serviceClient)closeServiceClient();
      return mcpPanelState.serviceSnapshot({client:serviceClient,language:locale.language,installed:serviceInstallation,
        selectedSpaceId:serviceSpaceId,error:serviceError,taskChatsAvailable:true});
    }
    let connected=false;
    try{if(core.state.activeConnection?.provider && core.state.account && !core.state.limits.error){connections.assertCurrent(core.state.activeConnection);connected=true;}}catch{}
    return mcpPanelState.snapshot({records:mcpRecords(),language:locale.language,connection:connections.display(),connected,bridgeRunning:!!mcpHost.bridge,
      pending:task=>mcpHost.tasks?.adapter.pending(task) || []});
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
    if(serviceMode){if(!serviceInstallation)throw Error('Install the service launcher first.');return serviceInstallation.configuration;}
    if(!mcpHost.bridge)throw Error('Start the MCP bridge first.');
    return {mcpServers:{rundix:{command:'node',args:[mcpHost.launcher,'--bridge',mcpHost.bridge.descriptor]}}};
  }
  async function handleMcpPanel(message) {
    if(!message || typeof message.action!=='string')throw Error('Invalid MCP panel action.');
    if(serviceMode && message.action==='selectSpace') {
      if(!vscode.workspace.isTrusted || !serviceClient?.spaces.some(space=>space.spaceId===message.spaceId))throw Error('Unknown space');
      serviceSpaceId=message.spaceId;publishMcpPanel(true);return;
    }
    if(message.action==='ready' || message.action==='refresh'){
      if(serviceMode && !serviceStopped)serviceWanted=true;
      if(serviceMode && !serviceStopped && serviceWanted && !serviceClient && vscode.workspace.isTrusted)await startMcp();
      if(serviceMode && message.action==='refresh' && serviceClient)await Promise.all(serviceClient.spaces.map(space=>serviceClient.refresh(space.spaceId)));
      publishMcpPanel(true);return;
    }
    if(serviceMode && ['openChat','cancel','continue','close'].includes(message.action)) {
      if(!vscode.workspace.isTrusted || !serviceClient)throw Object.assign(Error('Service connection is unavailable.'),{code:'service_unavailable'});
      const client=serviceClient,spaceId=message.spaceId;
      if(!client.spaces.some(space=>space.spaceId===spaceId))throw Object.assign(Error('Space is not bound.'),{code:'space_not_bound'});
      if(message.action==='openChat'){await openServiceChat(spaceId,message.taskId);return;}
      if(typeof message.requestId!=='string' || !/^[\w-]{1,128}$/.test(message.requestId))throw Error('Invalid panel requestId.');
      await client.call(spaceId,({cancel:'cancel_task',continue:'continue_task',close:'close_task'})[message.action],{
        taskId:message.taskId,...(message.action==='close'?{}:{requestId:message.requestId}),
        ...(message.action==='continue'?{clarification:message.clarification}:{})});
      if(client===serviceClient)await client.refresh(spaceId);
      publishMcpPanel(true);return;
    }
    if(message.action==='connectPool')await connectMcpPool();
    else if(message.action==='start'){if(!serviceMode)await connectMcpPool();await startMcp();}
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
        if(view(existing)?.panel)select(existing);else create(saved);
      }else {
        if(!mcpHost.tasks || !vscode.workspace.isTrusted)throw Error('Start the MCP bridge in a trusted workspace.');
        if(typeof message.requestId!=='string' || !/^[\w-]{1,128}$/.test(message.requestId))throw Error('Invalid panel requestId.');
        await mcpHost.tasks.call(message.action==='cancel'?'cancel_task':'continue_task',{
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
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('rundix.serviceTask',{
    async deserializeWebviewPanel(panel,state){
      if(!serviceMode || !state || typeof state.spaceId!=='string' || typeof state.taskId!=='string'){panel.dispose();return;}
      const key=serviceChatKey(state.spaceId,state.taskId);
      if(serviceChats.has(key)){panel.dispose();return;}
      const record=attachServiceChat(panel,state.spaceId,state.taskId);
      try{if(serviceStopped){await postServiceChat(record,null);return;}await startMcp();await refreshServiceChat(record);}catch{await postServiceChat(record,null);}
    },
  }));
  const mcpPanelTimer=setInterval(()=>publishMcpPanel(),1000);
  context.subscriptions.push({dispose(){clearInterval(mcpPanelTimer);}});
  const mcpHost=createMcpHost({core,storageRoot:context.globalStorageUri.fsPath,
    version:context.extension.packageJSON.version,
    settings:key=>vscode.workspace.getConfiguration('rundix').inspect(key)?.globalValue,
    trusted:()=>vscode.workspace.isTrusted,
    ui:{openChat:saved=>create(saved),hasChat,closeTab,
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
      reloadWindow:()=>{void vscode.commands.executeCommand('workbench.action.reloadWindow');},
      async sent(s,text,options={}){
        publish(s,true);
        await view(s).panel?.webview.postMessage({type:'sent',key:s.key,text,...options});
      },
      enabled:enabled=>context.globalState.update('mcpEnabled',enabled),
      changed:()=>broadcast(),
    }});
  async function startMcp() {
    if(!serviceMode)return mcpHost.start();
    serviceWanted=true;
    serviceStopped=false;
    if(serviceStarting){
      if(serviceStartingEpoch===serviceEpoch)return serviceStarting;
      const pending=serviceStarting,epoch=serviceEpoch;
      await pending.catch(()=>{});
      if(!serviceWanted || serviceDisposed || epoch!==serviceEpoch)throw Error('Window binding changed.');
      return startMcp();
    }
    const epoch=serviceEpoch;
    serviceStartingEpoch=epoch;
    serviceStarting=(async()=>{
      if(serviceDisposed || !vscode.workspace.isTrusted)throw Error('Workspace trust is required.');
      await context.globalState.update('mcpServiceStopped',false);
      if(serviceEpoch!==epoch || !serviceWanted)throw Error('Window binding changed.');
      serviceInstallation ||= await require('./runtime/service-launcher.cjs').installLauncherAsync({legacyRoot:context.globalStorageUri.fsPath});
      if(serviceDisposed || serviceEpoch!==epoch)throw Error('Window binding changed.');
      await syncServiceSettings();
      if(serviceEpoch!==epoch)throw Error('Window binding changed.');
      await connectServiceWindow();
      await context.globalState.update('mcpEnabled',true);publishMcpPanel(true);
      return serviceInstallation.launcher;
    })().catch(error=>{serviceError=['legacy_owner_active','migration_conflict'].includes(error.code)?error.code:'service_unavailable';publishMcpPanel(true);throw error;}).finally(()=>{serviceStarting=null;});
    return serviceStarting;
  }
  async function stopMcp() {
    if(!serviceMode)return mcpHost.stop();
    serviceWanted=false;
    serviceStopped=true;
    closeServiceClient();serviceInstallation=null;await context.globalState.update('mcpServiceStopped',true);await context.globalState.update('mcpEnabled',false);
  }
  context.subscriptions.push(vscode.commands.registerCommand('rundix.mcpStart',async()=>{
    if(!serviceMode)await connectMcpPool();
    const descriptor=await startMcp();
    const config=mcpConfiguration();
    const document=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(config,null,2)});
    await vscode.window.showTextDocument(document);
    return descriptor;
  }),vscode.commands.registerCommand('rundix.mcpStop',stopMcp));
  if(context.globalState.get('mcpEnabled',false) && (!serviceMode || !serviceStopped))void startMcp().catch(()=>{});
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
  const isActive = (s) => !!view(s).panel?.active && view(s).host?.activeKey === s.key;
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
    const host = view(s).host;
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
          models: core.state.catalog,
          cli: {...cliInfo, channel:cliChannel(),autoUpdate:vscode.workspace.getConfiguration('rundix').get('cliAutoUpdate',true),custom:!!configuredCliPath()},
          modelsUpdatedAt: core.state.catalogUpdatedAt,
          account: connections.projectAccount(core.state.account),
          connection: connections.display(),
          mcpBridgeRunning:serviceMode?!!serviceClient?.peer && !serviceClient.peer.closed:!!mcpHost.bridge,
          authBusy: core.state.authBusy,
          chatWidth:vscode.workspace.getConfiguration('rundix').get('chatWidth','wide'),
          contextDisplay:vscode.workspace.getConfiguration('rundix').get('contextDisplay','percent'),
          controlMotion:vscode.workspace.getConfiguration('rundix').get('controlMotion','auto'),
          activityMotion:vscode.workspace.getConfiguration('rundix').get('activityMotion','auto'),
          limits: core.state.limits,
          loginPending: !!core.state.loginId,
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
          capacityRetry:s.capacityRetry || null,
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
      core.state.cliPrepared=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,
        title:locale.t('Подготовка Codex CLI'),cancellable:false},progress=>cliUpdates.prepare(preparedChannel,{
          onProgress:message=>progress.report({message}),
        }));
      core.state.cliPrepared.channel=preparedChannel;
      executable=core.state.cliPrepared.executable;cliInfo={...cliInfo,version:core.state.cliPrepared.version,managed:true};
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
    if(core.state.disposed || configuredCliPath() || (!force && !config.get('cliAutoUpdate',true)))return;
    const channel=cliChannel();
    cliCheckRequest=(async()=>{
      cliInfo={...cliInfo,phase:'checking',error:false};broadcast();
      const candidate=await cliUpdates.prepare(channel,{force,onProgress:()=>{cliInfo.phase='downloading';broadcast();}});
      if(core.state.disposed||channel!==cliChannel())return;
      if(configuredCliPath() || (!force&&!vscode.workspace.getConfiguration('rundix').get('cliAutoUpdate',true))){cliInfo.phase='idle';return;}
      cliInfo.checkedAt=Date.now();
      if(core.state.server?.executable===candidate.executable){cliUpdates.accept(channel,candidate);cliInfo={...cliInfo,version:candidate.version,managed:true,phase:'ready'};await refreshCatalog();return;}
      if(core.state.authBusy||core.state.loginId||core.state.accountStatusRequest||pendingRequests.size||[...sessions.values()].some(s=>s.busy||s.compacting)) {cliInfo.phase='pending';return;}
      let release;
      try {release=store.acquire('account-credentials');store.assertNoActiveTurns();}
      catch {release?.();cliInfo.phase='pending';return;}
      const previous={executable:core.state.server?.executable,info:{...cliInfo}};
      core.state.authBusy=true;cliInfo.phase='applying';broadcast();
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
      }finally{core.state.authBusy=false;release();}
    })().catch(()=>{cliInfo={...cliInfo,phase:'error',error:true};}).finally(()=>{cliCheckRequest=null;broadcast();if(!core.state.disposed&&channel!==cliChannel())void checkCliUpdates(true);});
    return cliCheckRequest;
  }
  function connect(...args) { return core.connect(...args); }
  const refreshAccount = (...args) => core.refreshAccount(...args);
  const withLocalSignIn = (...args) => core.withLocalSignIn(...args);
  function browserSignInMessage(...args) { return core.browserSignInMessage(...args); }
  const refreshAccountStatus = (...args) => core.refreshAccountStatus(...args);
  const stopAccountServer = (...args) => core.stopAccountServer(...args);
  const resetConnection = (...args) => core.resetConnection(...args);
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
      await connections.menu.refresh();
    });
  }
  async function chooseConnection() {
    if (pendingLogin.current) throw Error('Browser sign-in is pending. Complete or cancel it before changing connections.');
    const choice = await vscode.window.showQuickPick(connections.choices().map(item => ({label:item.label,id:item.id})), {title:'Rundix · '+locale.t('Подключение'),placeHolder:locale.t('Выберите или настройте подключение')});
    if (choice) await configureConnection(choice.id);
  }
  const refreshLimits = (...args) => core.refreshLimits(...args);
  const updateDraftModel = (...args) => core.updateDraftModel(...args);
  const refreshCatalog = (...args) => core.refreshCatalog(...args);
  function save(...args) { return core.save(...args); }
  function html(webview) {
    const nonce = randomBytes(18).toString("base64");
    const uri = (name) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, "ui", name),
      );
    return `<!doctype html><html lang="${locale.language}" data-language="${locale.language}" data-ui-version="${require("./package.json").version}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;"><link rel="stylesheet" href="${uri("app.css")}"></head><body><main id="app"></main><script nonce="${nonce}" src="${uri("translations.js")}"></script><script nonce="${nonce}" src="${uri("i18n.js")}"></script><script nonce="${nonce}" src="${uri("forms.js")}"></script><script nonce="${nonce}" src="${uri("questions.js")}"></script><script nonce="${nonce}" src="${uri("question-panel.js")}"></script><script nonce="${nonce}" src="${uri("task-preflight.js")}"></script><script nonce="${nonce}" src="${uri("icons.js")}"></script><script nonce="${nonce}" src="${uri("tabs.js")}"></script><script nonce="${nonce}" src="${uri("controls.js")}"></script><script nonce="${nonce}" src="${uri("toggles.js")}"></script><script nonce="${nonce}" src="${uri("modes.js")}"></script><script nonce="${nonce}" src="${uri("speed.js")}"></script><script nonce="${nonce}" src="${uri("changes.js")}"></script><script nonce="${nonce}" src="${uri("limits.js")}"></script><script nonce="${nonce}" src="${uri("limits-view.js")}"></script><script nonce="${nonce}" src="${uri("markdown.js")}"></script><script nonce="${nonce}" src="${uri("markdown-view.js")}"></script><script nonce="${nonce}" src="${uri("messages.js")}"></script><script nonce="${nonce}" src="${uri("activity.js")}"></script><script nonce="${nonce}" src="${uri("transcript-scroll.js")}"></script><script nonce="${nonce}" src="${uri("queued-editor.js")}"></script><script nonce="${nonce}" src="${uri("composer-drafts.js")}"></script><script nonce="${nonce}" src="${uri("app.js")}"></script></body></html>`;
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
  function syncExternal(...args) { return core.syncExternal(...args); }
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
    if (!view(s)?.panel) return;
    const host = view(s).host;
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
    if (!s || view(s).host !== host || !view(s).panel) {
      const active = sessions.get(host.activeKey);
      if (active) publish(active);
      return;
    }
    if (
      typeof msg.currentDraft === "string" &&
      msg.currentDraft.length <= 200000
    ) {
      composerDraft.userEdit(s,msg.currentDraft);
      await save(s);
    }
    if (msg.action === "activateTab") {
      const next = sessions.get(msg.tabKey);
      if (view(next)?.host === host && view(next).panel) select(next);
      return;
    }
    if (msg.action === "closeTab") {
      const tab = sessions.get(msg.tabKey);
      if (view(tab)?.host === host && view(tab).panel) await closeTab(tab);
      return;
    }
    if (msg.action === "renameTab") {
      const tab = sessions.get(msg.tabKey);
      if (view(tab)?.host === host && view(tab).panel)
        await handle(tab, { action: "rename", name: msg.name });
      return;
    }
    if (msg.action === "forkTab" || msg.action === "moveTab") {
      const tab = sessions.get(msg.tabKey);
      if (view(tab)?.host === host && view(tab).panel)
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
      if (view(session)?.host === host) publish(session, true);
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
        view(s).panel = null;
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
    if (view(existing)?.panel && !panel) return select(existing);
    // Capture before creating/revealing a panel changes the active host.
    const inherited = restored ? {} : newSessionSettings(target(), cwd());
    const host = forcedHost || createHost(panel, column);
    const s = core.createSession({ key, saved, inherited });
    sessionViews.set(s, { host, panel: host.panel });
    if (!host.keys.includes(key)) host.keys.push(key);
    void save(s);
    return select(s, !panel && reveal);
  }
  async function closeTab(s) {
    const host = view(s).host,
      index = host.keys.indexOf(s.key);
    if (index < 0) return;
    await save(s);
    await library.close(s, host.panel?.viewColumn);
    view(s).panel = null;
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
  function resume(...args) { return core.resume(...args); }
  function send(...args) { return core.send(...args); }
  function hasPendingQuestions(...args) { return core.hasPendingQuestions(...args); }
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
  function queueFollowUp(...args) { return core.queueFollowUp(...args); }
  function steer(...args) { return core.steer(...args); }
  function drainFollowUps(...args) { return core.drainFollowUps(...args); }
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
      await core.state.server.request("thread/settings/update", {
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
          if(!view(destination).panel)return;
          try {
            const result=await send(destination,destination.draft,destination.attachments,{modelSelection});
            if(result?.waitUntil)throw Error(locale.t('Очередь ожидает сброса лимитов. Повторите отправку позже.'));
            destination.draft='';await save(destination);publish(destination);
            await view(destination).panel?.webview.postMessage({type:'sent',key:destination.key});
          } catch(error) {destination.error=error.message;publish(destination);}
        },
      });
    } else if (msg.action === 'cancelQueuedEdit') {
      if (s.queuedAttachmentDraft?.editId === msg.editId) delete s.queuedAttachmentDraft;
    } else if (['pickQueuedFiles', 'pasteQueuedImage'].includes(msg.action)) {
      if (typeof msg.requestId !== 'string' || !/^[\w-]{1,100}$/.test(msg.requestId)) throw Error('Invalid queue attachment request');
      try {
        const files = await stageQueuedAttachments(s, msg, { chatIdentity: () => hasChat(s) ? view(s).panel : null, latest: () => store.session(s.key),
          pickFiles: () => vscode.window.showOpenDialog({ canSelectMany: true, openLabel: locale.t('Добавить в контекст') }),
          pasteImage: data => savePastedImage(pastedImageRoot, data) });
        await view(s).panel?.webview.postMessage({ type: 'queuedAttachmentsResult', key: s.key, editId: msg.editId,
          requestId: msg.requestId, ok: true, attachments: files.map(file => ({id:file.id,name:file.name,kind:file.kind})) });
      } catch (error) {
        await view(s).panel?.webview.postMessage({ type: 'queuedAttachmentsResult', key: s.key, editId: msg.editId, requestId: msg.requestId, ok: false });
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
        await view(s).panel?.webview.postMessage({type:'queuedEditResult',key:s.key,requestId:msg.requestId,ok:false});
        throw error;
      }
      await view(s).panel?.webview.postMessage({type:'queuedEditResult',key:s.key,requestId:msg.requestId,ok:true});
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
      return core.answerAsync(s, msg);
    } else if (msg.action === "send" || msg.action === 'enqueue') {
      if(s.approvingTask)throw Error(locale.t('Дождитесь обработки уточнений перед согласованием.'));
      if(preflight.preparing(s.preflight))s.preflight.skipped=false;
      if (typeof msg.text === 'string' && msg.text.length <= 200000) {
        composerDraft.userEdit(s,msg.text);
        await save(s);
      }
      if(typeof msg.text!=='string'||msg.text.length>200000 || (!msg.text.trim()&&!s.attachments.some(file=>file.kind==='image')))throw Error(locale.t('Введите сообщение длиной до 200 000 символов.'));
      // Follow-ups wait by default; steering is an explicit action on a pending message.
      if(s.busy || s.followUpSending || s.followUps?.length || msg.action==='enqueue'){
        await queueFollowUp(s,msg.text,[...s.attachments]);
        await view(s).panel?.webview.postMessage({type:'sent',key:s.key,text:msg.text});
        if(!s.busy)await drainFollowUps(s);
        return;
      }
      let sendResult = await send(s, msg.text);
      while (sendResult?.waitUntil) {
        connections.assertCurrent(sendResult.connection);
        const waitingConnection = sendResult.connection;
        const proceed = await waitingConnection.provider.waitForReset(sendResult.waitUntil, () => {
          try { connections.assertCurrent(waitingConnection); return hasChat(s); } catch { return false; }
        });
        if (!proceed) throw Error('Waiting cancelled. Your draft is preserved.');
        connections.assertCurrent(sendResult.connection);
        sendResult = await send(s, msg.text);
      }
      await save(s);
      await view(s).panel?.webview.postMessage({ type: "sent", key: s.key, text:msg.text, consumeDraft:sendResult.draftConsumed });
    } else if (msg.action === "draft") {
      if (typeof msg.text === "string" && msg.text.length <= 200000) {
        composerDraft.userEdit(s,msg.text,{explicit:true});
        await save(s);
      }
    } else if (msg.action === "stop") {
      return core.stop(s);
    } else if (msg.action === "language") {
      if (!["auto", "en", "ru"].includes(msg.language))
        throw Error("Unsupported interface language.");
      if (
        typeof msg.currentDraft === "string" &&
        msg.currentDraft.length <= 200000
      ) {
        composerDraft.userEdit(s,msg.currentDraft);
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
      const result = await core.state.server.request("thread/fork", {
        threadId: s.id,
        ...(item ? { lastTurnId: item.turnId } : {}),
        cwd: s.cwd || cwd(),
        ephemeral: false,
        excludeTurns: true,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      const name = s.name + locale.t(" — ветка");
      await core.state.server.request("thread/name/set", {
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
      const previous = view(s).host;
      previous.keys = previous.keys.filter((key) => key !== s.key);
      view(s).panel = null;
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
        await core.state.server.request("thread/name/set", { threadId: s.id, name });
      }
      s.name = name;
      s.customName = true;
      await save(s);
      publish(s);
    } else if (msg.action === "history") {
      const result = await loadHistory(msg);
      await view(s).panel?.webview.postMessage({
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
      const page = await core.state.server.request("thread/items/list", {
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
      const model = core.state.catalog.find(
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
        await core.state.server.request("thread/settings/update", {
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
      const tier=speed.fastTier(core.state.catalog.find(model=>model.model===s.model));
      if(msg.enabled && !tier)throw Error(locale.t('Fast недоступен для этой модели или аккаунта.'));
      if(s.id){
        if(!s.loaded)await resume(s,s.id);
        await core.state.server.request('thread/settings/update',{threadId:s.id,serviceTier:msg.enabled?tier:null});
      }
      s.prefs.fast=msg.enabled;await save(s);publish(s);
    } else if (msg.action === "mode") {
      await setMode(s, msg.mode);
    } else if (msg.action === "ultra") {
      if (typeof msg.enabled !== "boolean") return;
      await connect();
      const model = core.state.catalog.find((m) => m.model === s.model),
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
        void view(s).host?.panel?.webview.postMessage({type:'pasteImageResult',requestId:msg.requestId});
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
      if (core.state.authBusy) throw Error(locale.t('Дождитесь переключения аккаунта.'));
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
        await core.state.server.request("thread/compact/start", { threadId: s.id });
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
        await view(s).panel?.webview.postMessage({
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
          const page = await core.state.server.request("thread/items/list", {
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
        await view(s).panel?.webview.postMessage({
          type: "revealItem",
          key: s.key,
          itemId: bookmark.id,
        });
      }
    } else if (msg.action === "skills") {
      await connect();
      const result = await core.state.server.request("skills/list", {
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
      await view(s).panel?.webview.postMessage({
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
      await view(s).panel?.webview.postMessage({
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
      await view(s).panel?.webview.postMessage({
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
      return core.answer(s, msg);
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
    } else if (msg.action === 'connectionMenuAction') {
      await withLocalSignIn(async () => {
        const outcome=await connections.menu.run(msg.revision,msg.id);
        if (outcome === 'activate') await resetConnection();
        await connections.menu.refresh();
      });
    } else if (msg.action === 'accountRefresh') {
      const readingMenu=connections.menu.refresh(broadcast);
      broadcast();
      try { await readingMenu; broadcast(); await refreshAccountStatus(); }
      finally { broadcast(); }
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
        const record = pendingLogin.begin(core.state.server, release);
        try {
          await startLogin(record.client, {
            onStarted: id => {
              if (pendingLogin.current !== record) throw Error('Browser sign-in expired. Please try again.');
              if (!id) throw Error('CLI did not return a login identifier.');
              record.id = core.state.loginId = id;
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
      if(core.state.authBusy)throw Error(locale.t('Дождитесь переключения аккаунта.'));
      if ([...sessions.values()].some(session => session.busy || session.compacting))
        throw Error(locale.t('Дождитесь завершения задач перед переподключением.'));
      core.state.connecting = null;
      core.state.server?.dispose();
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
      (s) => view(s).panel && (entry.key ? s.key === entry.key : s.id === entry.id),
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
    return view(active)?.panel
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
                view(s).panel &&
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
      .filter((s) => view(s).panel)
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
    const result = await core.state.server.request("thread/list", {
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
      if (view(s)?.panel) return closeTab(s);
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
      void view(s).panel.webview.postMessage({ type: "open", action: "history" });
    },
    rename: async (item) => {
      const s = target(item);
      if (s) {
        const open = view(s).panel ? s : openEntry(s);
        const name=await vscode.window.showInputBox({title:locale.t('Переименовать вкладку'),value:open.name,ignoreFocusOut:true,
          validateInput:value=>value.trim() && value.trim().length<=200?null:locale.t('Имя должно содержать от 1 до 200 символов.')});
        if(name!==undefined)await handle(open,{action:'rename',name});
      }
    },
    group: (item) => {
      const s = target(item);
      if (s) {
        const open = view(s).panel ? select(s) : openEntry(s);
        void view(open).panel.webview.postMessage({ type: "open", action: "group" });
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
      if (key === activeKey || view(sessions.get(key))?.panel) continue;
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
      core.state.disposed=true;clearInterval(maintenanceTimer);
      core.state.server?.dispose(); pendingLogin.finish();
      mcpHost.dispose();
    },
  });
  let lastCliCheck=0;
  const maintenanceTimer=setInterval(()=>{
    if(core.state.disposed||!core.state.server?.child)return;
    if(Date.now()-lastCliCheck>=3600000 || cliInfo.phase==='pending') {
      lastCliCheck=Date.now();void checkCliUpdates();
    }
    if(Date.now()-core.state.catalogUpdatedAt>=300000)void refreshCatalog().catch(()=>{});
  },60000);
  return {
    connections: {
      version: 1,
      menuVersion: 1,
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
    mcp:{start:startMcp,stop:stopMcp,tasks:()=>mcpHost.tasks,connectPool:connectMcpPool,panelSnapshot:mcpPanelSnapshot,panelAction:handleMcpPanel,openPanel:openMcpEditor,
      serviceChats,chatAction:serviceChatAction},
    create,
    connect,
    sessions,
    hosts,
    view,
    server: () => core.state.server,
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
