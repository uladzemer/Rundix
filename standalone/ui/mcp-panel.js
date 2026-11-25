/* global acquireVsCodeApi, WorkbenchI18n, WorkbenchControls */
(()=>{
  const api=acquireVsCodeApi(), root=document.getElementById('app');
  let saved=api.getState() || {}, drafts=saved.drafts || {}, selected=saved.selected || null, state=null, pending=false, error='', submission=null, requestId=null;
  const versions={}, attempts=saved.attempts || {};
  let configuration=null,copied=false,settingsFocus=null,restartRequestId=null,restartError=false;
  let clearResult=null;
  const configurationText={ru:{title:'Подключение Claude Code',hint:'Эти настройки связывают Claude Code с Rundix. Если сервер rundix уже добавлен, перезапустите сессию Claude Code и проверьте /mcp. VS Code должен оставаться открытым.',copy:'Скопировать настройки',copied:'Настройки скопированы'},en:{title:'Connect Claude Code',hint:'These settings connect Claude Code to Rundix. If rundix is already registered, restart your Claude Code session and check /mcp. VS Code must remain open.',copy:'Copy configuration',copied:'Configuration copied'}};
  const words={
    en:{unsent:'Unsent inputs: recover full text with get_task',title:'MCP tasks',subtitle:'Claude Code → Codex',pool:'Connection',local:'Select a companion connection',ready:'Connected',unchecked:'Not checked',bridgeOn:'MCP bridge running',bridgeOff:'MCP bridge stopped',connect:'Connect companion',start:'Start MCP',stop:'Stop MCP',config:'Claude configuration',refresh:'Refresh',empty:'No MCP tasks yet. Start the bridge and submit a task from Claude Code.',open:'Open chat',cancel:'Cancel task',follow:'Continue in the same chat',placeholder:'Clarification or next step…',send:'Send continuation',report:'Final report',result:'Result',files:'Changed files',checks:'Checks performed',issues:'Remaining issues',none:'None reported',approval:'Approval required — open the chat to review the request, or answer in Claude Code.',recovery:'Execution requires verification. Inspect the chat before continuing.',offline:'Tasks are paused while the bridge is stopped.',failed:'Action failed. Check the selected connection, workspace trust and task state.',queued:'Queued',running:'Running',waiting_approval:'Waiting for approval',completed:'Completed',error:'Error',cancelled:'Cancelled',working:'Working…',copy:'Task ID',context:'VS Code must remain open. Tasks use the selected companion and its server limits.'},
    ru:{unsent:'\u041d\u0435\u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043d\u044b\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f: \u043f\u043e\u043b\u043d\u044b\u0439 \u0442\u0435\u043a\u0441\u0442 \u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d \u0447\u0435\u0440\u0435\u0437 get_task',title:'Задачи MCP',subtitle:'Claude Code → Codex',pool:'Подключение',local:'Выберите companion-подключение',ready:'Подключено',unchecked:'Не проверено',bridgeOn:'Мост MCP запущен',bridgeOff:'Мост MCP остановлен',connect:'Подключить companion',start:'Запустить MCP',stop:'Остановить MCP',config:'Конфигурация Claude',refresh:'Обновить',empty:'Задач MCP пока нет. Запустите мост и отправьте задачу из Claude Code.',open:'Открыть чат',cancel:'Отменить задачу',follow:'Продолжить в том же чате',placeholder:'Уточнение или следующий шаг…',send:'Отправить уточнение',report:'Итоговый отчёт',result:'Результат',files:'Изменённые файлы',checks:'Выполненные проверки',issues:'Оставшиеся проблемы',none:'Не указаны',approval:'Требуется подтверждение — откройте чат для проверки запроса или ответьте в Claude Code.',recovery:'Нужно проверить исполнение. Просмотрите чат перед продолжением.',offline:'Задачи приостановлены, пока мост остановлен.',failed:'Действие не выполнено. Проверьте подключение, доверие рабочей области и состояние задачи.',queued:'В очереди',running:'Выполняется',waiting_approval:'Ожидает подтверждения',completed:'Завершена',error:'Ошибка',cancelled:'Отменена',working:'Выполняется…',copy:'ID задачи',context:'VS Code должен оставаться открытым. Задачи используют выбранный companion и его серверные лимиты.'}
  };
  Object.assign(words.en,{space:'Project space',waiting_limit:'Waiting for limits',reset:'Reset at',resetUnknown:'Reset time unknown',actionRequired:'Connection action required',close:'Close task',unsentCount:'Unsent inputs',low_remaining:'Low remaining quota',exhausted:'Quota exhausted',limits_unknown:'Limits unknown',reset_unknown:'Reset time unknown',active_turns:'Waiting for active turns',action_required:'Connection action required',connection_changed:'Connection changed'});
  Object.assign(words.ru,{space:'Пространство проекта',waiting_limit:'Ожидает лимитов',reset:'Сброс лимитов',resetUnknown:'Время сброса неизвестно',actionRequired:'Требуется действие с подключением',close:'Закрыть задачу',unsentCount:'Неотправленные сообщения',low_remaining:'Осталось мало лимитов',exhausted:'Лимиты исчерпаны',limits_unknown:'Лимиты неизвестны',reset_unknown:'Время сброса неизвестно',active_turns:'Ожидает завершения активных задач',action_required:'Требуется действие с подключением',connection_changed:'Подключение изменилось'});
  Object.assign(words.en,{modelSettings:'Model for new tasks',model:'Model',effort:'Reasoning effort',automatic:'Automatic (GPT-6.2 Sol · Medium when available)',regular:'Same as regular chat',auto:'Auto',unavailable:'unavailable',modelsIdle:'Start MCP to load the model list',modelsLoading:'Loading models…',modelsUnavailable:'Models unavailable, press Refresh',newTasks:'Applies to new tasks only. A model passed in submit_task wins.'});
  Object.assign(words.ru,{modelSettings:'Модель для новых задач',model:'Модель',effort:'Глубина размышления',automatic:'Автоматически (GPT-6.2 Sol · Medium, если доступна)',regular:'Как в обычном чате',auto:'Авто',unavailable:'недоступна',modelsIdle:'Запустите MCP, чтобы загрузить список моделей',modelsLoading:'Загрузка моделей…',modelsUnavailable:'Модели недоступны, нажмите «Обновить»',newTasks:'Применяется только к новым задачам. Модель, переданная в submit_task, имеет приоритет.'});
  Object.assign(words.en,{serviceVersion:'Service version',outdated:'The service is older than the extension',legacyRestart:'To update the service, finish its tasks, disconnect MCP clients, and close connected windows or use Stop MCP in them. The service exits after five idle minutes.',restart:'Restart service',restarting:'Restarting service…',restartConfirm:'Confirm restart in VS Code. Active tasks across all projects',service_restart_failed:'Could not restart the service.'});
  Object.assign(words.ru,{serviceVersion:'Версия сервиса',outdated:'Сервис старее расширения',legacyRestart:'Для обновления сервиса завершите задачи, отключите MCP-клиентов и закройте подключённые окна или нажмите в них «Остановить MCP». Сервис завершится после пяти минут простоя.',restart:'Перезапустить сервис',restarting:'Перезапуск сервиса…',restartConfirm:'Подтвердите перезапуск в VS Code. Активных задач во всех проектах',service_restart_failed:'Не удалось перезапустить сервис.'});
  words.en.restartConfirmBusy='The service is performing a background operation. Confirm restart in VS Code.';
  words.ru.restartConfirmBusy='Сервис выполняет фоновую операцию. Подтвердите перезапуск в VS Code.';
  Object.assign(words.en,{archive:'Archive',clearFinished:'Clear finished',archived:'Archived',skipped:'Skipped',withUnsent:'With unsent text',emptyTaskList:'The task list is empty.',emptyArchive:'The archive is empty.'});
  Object.assign(words.ru,{archive:'Архив',clearFinished:'Убрать завершённые',archived:'Убрано в архив',skipped:'Пропущено',withUnsent:'С неотправленным текстом',emptyTaskList:'Список задач пуст.',emptyArchive:'Архив пуст.'});
  const t=key=>(words[state?.language==='ru'?'ru':'en'][key] || key);
  function element(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
  function persist(){api.setState({selected,drafts,attempts});}
  function nextRequestId(){
    return Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
  }
  function action(name,extra={}){
    if(name==='restartService'){
      if(restartRequestId || state.serviceRestart)return;
      restartRequestId=nextRequestId();restartError=false;render();
      api.postMessage({action:name,requestId:restartRequestId});return;
    }
    if(pending)return;
    clearResult=null;
    if(!restartRequestId && !state.serviceRestart)restartError=false;
    if(name==='setModelDefaults' || name==='archiveView')settingsFocus=document.activeElement?.id || null;
    pending=true;error='';submission=name==='continue'?{taskId:extra.taskId,version:versions[extra.taskId] || 0}:null;
    requestId=nextRequestId();
    const payload={action:name,...(state.serviceMode?{spaceId:state.spaceId}:{}),...extra};
    if(state.serviceMode && ['continue','cancel'].includes(name)){
      const key=JSON.stringify(payload);requestId=attempts[key] || requestId;attempts[key]=requestId;
    }
    persist();render();api.postMessage({...payload,requestId});
  }
  function button(text,name,extra,disabled=false){const b=element('button',text);b.type='button';b.disabled=pending || disabled;b.addEventListener('click',()=>action(name,extra));return b;}
  const selectionText=value=>(value.displayName || value.model)+(value.effort?' · '+WorkbenchControls.label(value.effort):'');
  words.en.possiblyNotDelivered='possibly not delivered';
  words.ru.possiblyNotDelivered='возможно, не доставлено';
  function modelSettings() {
    const defaults=state.modelDefaults || {model:null,effort:'auto'},catalog=state.models || {status:'idle',list:[]};
    const section=element('section',undefined,'model-settings'),model=element('select'),effort=element('select');
    section.append(element('h2',t('modelSettings')));model.id='mcp-model';effort.id='mcp-effort';
    const option=(select,value,text,selected)=>{const row=element('option',text);row.value=value;row.selected=selected;select.append(row);};
    // JSON values distinguish null, the empty string, and arbitrary catalog IDs.
    option(model,'null',t('automatic'),defaults.model===null);option(model,'""',t('regular'),defaults.model==='');
    for(const entry of catalog.list)option(model,JSON.stringify(entry.model),entry.displayName,defaults.model===entry.model);
    if(defaults.model && !catalog.list.some(entry=>entry.model===defaults.model))option(model,JSON.stringify(defaults.model),defaults.model+(catalog.status==='ready'?' ('+t('unavailable')+')':''),true);
    const supported=value=>{
      const entry=catalog.list.find(entry=>entry.model===(value===null?state.preferredModel:value));
      return value==='' || value===null && !entry?[...new Set(catalog.list.flatMap(entry=>entry.efforts))]:entry?.efforts || [];
    };
    option(effort,'auto',t('auto'),defaults.effort==='auto');
    const efforts=[...supported(defaults.model)];if(defaults.effort!=='auto' && !efforts.includes(defaults.effort))efforts.push(defaults.effort);
    for(const value of efforts)option(effort,value,WorkbenchControls.label(value),defaults.effort===value);
    for(const [control,key]of [[model,'model'],[effort,'effort']]){const label=element('label',t(key));label.htmlFor=control.id;section.append(label,control);control.disabled=pending || catalog.status!=='ready';}
    model.addEventListener('change',()=>{const value=JSON.parse(model.value);action('setModelDefaults',{model:value,effort:defaults.effort==='auto' || supported(value).includes(defaults.effort)?defaults.effort:'auto'});});
    effort.addEventListener('change',()=>action('setModelDefaults',{model:defaults.model,effort:effort.value}));
    if(catalog.status!=='ready')section.append(element('p',(defaults.model===null?t('automatic'):defaults.model===''?t('regular'):defaults.model)+' · '+(defaults.effort==='auto'?t('auto'):WorkbenchControls.label(defaults.effort)),'muted'),element('p',t(({loading:'modelsLoading',unavailable:'modelsUnavailable'})[catalog.status] || 'modelsIdle'),'models-hint muted'));
    section.append(element('p',t('newTasks'),'muted'));root.append(section);
  }
  function render(){
    if(!state)return;
    const focused=document.activeElement?.id || settingsFocus, start=document.activeElement?.selectionStart, end=document.activeElement?.selectionEnd, scroll=window.scrollY;
    const restore=()=>{
      const control=focused && document.getElementById(focused);
      if(control && !control.disabled){control.focus({preventScroll:true});if(focused==='clarification')control.setSelectionRange(start,end);settingsFocus=null;}
      window.scrollTo(0,scroll);
    };
    root.replaceChildren();document.documentElement.lang=state.language;WorkbenchI18n.setLanguage(state.language);
    const header=element('header');header.append(element('h1',t('title')),element('p',t('subtitle'),'eyebrow'));root.append(header);
    if(state.serviceMode){
      root.append(element('p',state.language==='ru'?'Задачи выполняются в фоновом сервисе. Закрытие окна не останавливает их.':'Tasks run in the background service. Closing this window leaves them running.','service-note'));
      if(state.legacyStatus && !['ready','vanished'].includes(state.legacyStatus.state))root.append(element('p',
        (state.language==='ru'?'Импорт старой истории: ':'Legacy history import: ')+({busy:state.language==='ru'?'старое окно занято; повтор позже':'legacy owner busy; retry later',retry_later:state.language==='ru'?'временная ошибка; повтор позже':'temporary failure; retry later',needs_repair:state.language==='ru'?'данные требуют восстановления':'data needs repair',pending:state.language==='ru'?'ожидается':'pending'}[state.legacyStatus.state] || state.legacyStatus.state),'legacy-status notice'));
      const controls=element('section',undefined,'connection');
      const actions=element('div',undefined,'actions');
      actions.append(button(t('start'),'start',{},state.bridgeRunning),button(t('stop'),'stop',{},!state.bridgeRunning && !state.serviceRestart),button(t('config'),'configuration',{},!state.configurationAvailable),button(t('refresh'),'refresh',{},!state.bridgeRunning));
      if(state.serviceCanRestart)actions.append(button(t('restart'),'restartService',{},!!(state.serviceRestart || restartRequestId)));
      controls.append(element('p',state.bridgeRunning?t('ready'):t('unchecked'),'bridge-status'),actions);root.append(controls);
      if(state.serviceVersion)controls.append(element('p',t('serviceVersion')+': '+state.serviceVersion,'service-version'));
      if(state.serviceOutdated){
        controls.append(element('p',t('outdated')+' ('+state.extensionVersion+').','service-outdated notice'));
        if(!state.serviceCanRestart)controls.append(element('p',t('legacyRestart'),'service-restart-hint muted'));
      }
      if(state.spaces?.length){
        const label=element('label',t('space')),select=element('select');select.id='space';label.htmlFor='space';select.disabled=pending;
        for(const space of state.spaces){const option=element('option',space.label);option.value=space.spaceId;option.selected=space.spaceId===state.spaceId;select.append(option);}
        select.addEventListener('change',()=>action('selectSpace',{spaceId:select.value}));root.append(label,select);
      }
      if(state.error)root.append(element('p',t('failed')+' '+state.error,'alert'));
    }else{
    const connection=element('section',undefined,'connection');
    connection.append(element('strong',t('pool')),element('p',state.connection?.external?state.connection.label:t('local')),
      element('p',state.connected?t('ready'):t('unchecked'),'muted'),element('p',state.bridgeRunning?t('bridgeOn'):t('bridgeOff'),'bridge-status'));
    const controls=element('div',undefined,'actions');controls.append(button(t('connect'),'connectPool'),button(t('start'),'start',{},state.bridgeRunning),button(t('stop'),'stop',{},!state.bridgeRunning),button(t('config'),'configuration',{},!state.bridgeRunning),button(t('refresh'),'refresh'));
    connection.append(controls,element('p',t('context'),'muted'));root.append(connection);
    }
    modelSettings();
    if(configuration){
      const labels=configurationText[state.language==='ru'?'ru':'en'],section=element('section',undefined,'claude-configuration');
      section.append(element('h2',labels.title),element('p',state.serviceMode?(state.language==='ru'?'Замените запись Rundix MCP и перезапустите Claude MCP.':'Replace the Rundix MCP entry and restart Claude MCP.'):labels.hint,'muted'),element('pre',JSON.stringify(configuration,null,2),'configuration-json'),button(copied?labels.copied:labels.copy,'copyConfiguration',{},!(state.serviceMode?state.configurationAvailable:state.bridgeRunning)));root.append(section);
    }
    function showStatus(message){
      const alert=element('p',message,'alert');alert.setAttribute('role','status');root.append(alert);
    }
    const restart=state.serviceRestart;
    if(restart?.phase==='restarting')showStatus(t('restarting'));
    else if(restart?.phase==='confirming')showStatus(restart.activeTasks?t('restartConfirm')+': '+restart.activeTasks:t('restartConfirmBusy'));
    else if(restart || restartRequestId)showStatus(t('working'));
    else if(restartError)showStatus(t('service_restart_failed'));
    if(error || pending)showStatus(pending?t('working'):error==='failed'?t('failed'):t('failed')+' '+error);
    const rows=state.tasks || [];
    if(state.serviceMode){
      if(clearResult && clearResult.spaceId===state.spaceId && state.bridgeRunning){
        const {archived,skipped,withUnsent}=clearResult.counts;
        showStatus(`${t('archived')} — ${archived}. ${t('skipped')} — ${skipped}. ${t('withUnsent')} — ${withUnsent}.`);
      }
      const actions=element('div',undefined,'actions');
      if(state.serviceCanClearFinished)actions.append(button(t('clearFinished'),'clearFinished'));
      if(state.archivedCount || state.archiveView){
        const toggle=button(`${t('archive')} (${state.archivedCount})`,'archiveView',{show:!state.archiveView});toggle.id='task-archive';
        toggle.setAttribute('aria-pressed',String(!!state.archiveView));actions.append(toggle);
      }
      if(actions.childElementCount)root.append(actions);
    }
    const tasks=state.serviceMode ? rows.filter(task=>!!task.archived===!!state.archiveView) : rows;
    if(!tasks.length){root.append(element('p',t(state.archiveView?'emptyArchive':state.archivedCount?'emptyTaskList':'empty'),'empty'));restore();return;}
    if(!tasks.some(task=>task.taskId===selected)){selected=tasks[0].taskId;persist();}
    const list=element('nav',undefined,'task-list');list.setAttribute('aria-label',t('title'));
    for(const task of tasks){
      const row=element('button',undefined,'task-row');row.type='button';row.setAttribute('aria-pressed',String(task.taskId===selected));row.dataset.taskId=task.taskId;
      row.append(element('span',task.title || task.taskId,'task-title'),element('span',t(task.state),'state state-'+task.state));
      row.addEventListener('click',()=>{selected=task.taskId;persist();render();});list.append(row);
    }
    root.append(list);
    const task=tasks.find(task=>task.taskId===selected), detail=element('section',undefined,'task-detail');
    detail.append(element('h2',task.title || task.taskId),element('p',t(task.state),'state state-'+task.state),element('code',task.taskId),element('p',task.projectDirectory,'directory'));
    if(task.lastSelection)detail.append(element('p',t('model')+': '+selectionText(task.lastSelection),'last-selection muted'));
    if(task.waitingLimit){
      detail.append(element('p',t(task.waitingLimit.reason),'notice'));
      detail.append(element('p',task.waitingLimit.resetAt?t('reset')+': '+new Date(task.waitingLimit.resetAt).toLocaleString(state.language==='ru'?'ru-RU':'en-US'):t('resetUnknown'),'limit-reset'));
    }
    if(task.actionRequired)detail.append(element('p',t('actionRequired')+': '+task.actionRequired,'notice'));
    if(state.serviceMode && task.unsentInputCount)detail.append(element('p',t('unsentCount')+': '+task.unsentInputCount,'unsent-count'));
    if(task.possiblyNotDeliveredCount)detail.append(element('p',t('possiblyNotDelivered')+': '+task.possiblyNotDeliveredCount,'possibly-not-delivered'));
    if(task.progress)detail.append(element('p',task.progress,'progress'));
    if(!state.bridgeRunning)detail.append(element('p',t('offline'),'notice'));
    if(task.pendingRequests?.length || typeof task.pendingRequests==='number' && task.pendingRequests>0)detail.append(element('p',t('approval'),'notice'));
    if(task.recoveryRequired && task.state==='error')detail.append(element('p',t('recovery'),'notice'));
    if(task.error)detail.append(element('p',task.error,'task-error'));
    if(task.unsentInputs?.length){
      const recovery=element('details',undefined,'unsent-inputs');
      recovery.append(element('summary',t('unsent')));
      for(const row of task.unsentInputs){
        if(row.possiblyNotDelivered)recovery.append(element('p',t('possiblyNotDelivered'),'possibly-not-delivered'));
        recovery.append(element('pre',row.text+(row.truncated?'…':''),'configuration-json'));
      }
      detail.append(recovery);
    }
    if(task.readOnly)detail.append(element('p',state.language==='ru'?'История старой версии · только чтение':'Legacy history · read only','notice'));
    const taskActions=element('div',undefined,'actions');taskActions.append(button(t('open'),'openChat',{taskId:task.taskId},!task.chatId || state.serviceMode && !state.taskChatsAvailable),button(t('cancel'),'cancel',{taskId:task.taskId},task.readOnly || !state.bridgeRunning || (!['queued','running','waiting_approval','waiting_limit'].includes(task.state) && !task.recoveryRequired)));if(state.serviceMode)taskActions.append(button(t('close'),'close',{taskId:task.taskId},task.readOnly || !state.bridgeRunning || !['completed','error','cancelled'].includes(task.state) || task.recoveryRequired || task.closed));detail.append(taskActions);
    if(task.report){
      const report=element('section',undefined,'report');report.append(element('h3',t('report')));
      if(task.report.truncated)report.append(element('p',state.language==='ru'?'Показана сокращённая версия. Полный отчёт доступен через get_task.':'Showing a shortened report. Full report is available through get_task.','notice'));
      for(const key of ['result','changedFiles','checks','remainingIssues']){
        report.append(element('h4',t(({changedFiles:'files',remainingIssues:'issues'})[key] || key)));
        const value=task.report[key];
        if(Array.isArray(value) && value.length){const ul=element('ul');for(const row of value)ul.append(element('li',typeof row==='string'?row:JSON.stringify(row)));report.append(ul);}
        else report.append(element('p',typeof value==='string' && value?value:t('none')));
      }
      detail.append(report);
    }
    const form=element('form'), label=element('label',t('follow')), input=element('textarea');
    label.htmlFor='clarification';input.id='clarification';input.placeholder=t('placeholder');input.maxLength=100000;input.rows=4;input.value=drafts[task.taskId] || '';
    input.addEventListener('input',()=>{drafts[task.taskId]=input.value;versions[task.taskId]=(versions[task.taskId] || 0)+1;persist();submit.disabled=pending || task.readOnly || !state.bridgeRunning || !input.value.trim();});
    const submit=element('button',t('send'));submit.type='submit';submit.disabled=pending || task.readOnly || !state.bridgeRunning || !input.value.trim();
    form.addEventListener('submit',event=>{event.preventDefault();if(!submit.disabled)action('continue',{taskId:task.taskId,clarification:input.value});});
    form.append(label,input,submit);detail.append(form);root.append(detail);
    restore();
  }
  window.addEventListener('message',event=>{
    const message=event.data;
    if(message?.type==='mcpState'){state=message.data;render();}
    if(message?.type==='mcpResult'){
      if(restartRequestId && message.requestId===restartRequestId){
        restartRequestId=null;restartError=!message.ok;render();return;
      }
      if(pending && message.requestId!==requestId)return;
      pending=false;error=message.ok?'':typeof message.error==='string' && message.error?message.error.slice(0,300):'failed';
      if(message.ok && message.action==='clearFinished' && message.clearFinished)clearResult={spaceId:message.spaceId,counts:message.clearFinished};
      if(message.ok && message.configuration){configuration=message.configuration;copied=message.action==='copyConfiguration';}
      if(message.ok && message.action==='continue' && submission?.taskId===message.taskId && submission.version===(versions[message.taskId] || 0)){delete drafts[message.taskId];persist();}
      if(message.ok){for(const [key,id]of Object.entries(attempts))if(id===message.requestId)delete attempts[key];persist();}
      submission=null;requestId=null;
      render();
    }
  });
  api.postMessage({action:'ready'});
})();
