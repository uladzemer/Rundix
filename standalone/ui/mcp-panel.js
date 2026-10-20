/* global acquireVsCodeApi */
(()=>{
  const api=acquireVsCodeApi(), root=document.getElementById('app');
  let saved=api.getState() || {}, drafts=saved.drafts || {}, selected=saved.selected || null, state=null, pending=false, error='', submission=null, requestId=null;
  const versions={};
  let configuration=null,copied=false;
  const configurationText={ru:{title:'Подключение Claude Code',hint:'Эти настройки связывают Claude Code с Rundix. Если сервер rundix уже добавлен, перезапустите сессию Claude Code и проверьте /mcp. VS Code должен оставаться открытым.',copy:'Скопировать настройки',copied:'Настройки скопированы'},en:{title:'Connect Claude Code',hint:'These settings connect Claude Code to Rundix. If rundix is already registered, restart your Claude Code session and check /mcp. VS Code must remain open.',copy:'Copy configuration',copied:'Configuration copied'}};
  const words={
    en:{title:'MCP tasks',subtitle:'Claude Code → Codex',pool:'Connection',local:'Select a companion pool',ready:'Connected',unchecked:'Not checked',bridgeOn:'MCP bridge running',bridgeOff:'MCP bridge stopped',connect:'Connect pool',start:'Start MCP',stop:'Stop MCP',config:'Claude configuration',refresh:'Refresh',empty:'No MCP tasks yet. Start the bridge and submit a task from Claude Code.',open:'Open chat',cancel:'Cancel task',follow:'Continue in the same chat',placeholder:'Clarification or next step…',send:'Send continuation',report:'Final report',result:'Result',files:'Changed files',checks:'Checks performed',issues:'Remaining issues',none:'None reported',approval:'Approval required — open the chat to review the request, or answer in Claude Code.',recovery:'Execution requires verification. Inspect the chat before continuing.',offline:'Tasks are paused while the bridge is stopped.',failed:'Action failed. Check the selected connection, workspace trust and task state.',queued:'Queued',running:'Running',waiting_approval:'Waiting for approval',completed:'Completed',error:'Error',cancelled:'Cancelled',working:'Working…',copy:'Task ID',context:'VS Code must remain open. Tasks use the selected companion and its server limits.'},
    ru:{title:'Задачи MCP',subtitle:'Claude Code → Codex',pool:'Подключение',local:'Выберите companion с рабочим пулом',ready:'Подключено',unchecked:'Не проверено',bridgeOn:'Мост MCP запущен',bridgeOff:'Мост MCP остановлен',connect:'Подключить пул',start:'Запустить MCP',stop:'Остановить MCP',config:'Конфигурация Claude',refresh:'Обновить',empty:'Задач MCP пока нет. Запустите мост и отправьте задачу из Claude Code.',open:'Открыть чат',cancel:'Отменить задачу',follow:'Продолжить в том же чате',placeholder:'Уточнение или следующий шаг…',send:'Отправить уточнение',report:'Итоговый отчёт',result:'Результат',files:'Изменённые файлы',checks:'Выполненные проверки',issues:'Оставшиеся проблемы',none:'Не указаны',approval:'Требуется подтверждение — откройте чат для проверки запроса или ответьте в Claude Code.',recovery:'Нужно проверить исполнение. Просмотрите чат перед продолжением.',offline:'Задачи приостановлены, пока мост остановлен.',failed:'Действие не выполнено. Проверьте подключение, доверие рабочей области и состояние задачи.',queued:'В очереди',running:'Выполняется',waiting_approval:'Ожидает подтверждения',completed:'Завершена',error:'Ошибка',cancelled:'Отменена',working:'Выполняется…',copy:'ID задачи',context:'VS Code должен оставаться открытым. Задачи используют выбранный companion и его серверные лимиты.'}
  };
  const t=key=>(words[state?.language==='ru'?'ru':'en'][key] || key);
  function element(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
  function persist(){api.setState({selected,drafts});}
  function action(name,extra={}){
    if(pending)return;
    pending=true;error='';submission=name==='continue'?{taskId:extra.taskId,version:versions[extra.taskId] || 0}:null;
    const bytes=crypto.getRandomValues(new Uint8Array(16));requestId=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
    render();api.postMessage({action:name,requestId,...extra});
  }
  function button(text,name,extra,disabled=false){const b=element('button',text);b.type='button';b.disabled=pending || disabled;b.addEventListener('click',()=>action(name,extra));return b;}
  function render(){
    if(!state)return;
    const focused=document.activeElement?.id, start=document.activeElement?.selectionStart, end=document.activeElement?.selectionEnd, scroll=window.scrollY;
    root.replaceChildren();document.documentElement.lang=state.language;
    const header=element('header');header.append(element('h1',t('title')),element('p',t('subtitle'),'eyebrow'));root.append(header);
    const connection=element('section',undefined,'connection');
    connection.append(element('strong',t('pool')),element('p',state.connection?.external?state.connection.label:t('local')),
      element('p',state.connected?t('ready'):t('unchecked'),'muted'),element('p',state.bridgeRunning?t('bridgeOn'):t('bridgeOff'),'bridge-status'));
    const controls=element('div',undefined,'actions');controls.append(button(t('connect'),'connectPool'),button(t('start'),'start',{},state.bridgeRunning),button(t('stop'),'stop',{},!state.bridgeRunning),button(t('config'),'configuration',{},!state.bridgeRunning),button(t('refresh'),'refresh'));
    connection.append(controls,element('p',t('context'),'muted'));root.append(connection);
    if(configuration){
      const labels=configurationText[state.language==='ru'?'ru':'en'],section=element('section',undefined,'claude-configuration');
      section.append(element('h2',labels.title),element('p',labels.hint,'muted'),element('pre',JSON.stringify(configuration,null,2),'configuration-json'),button(copied?labels.copied:labels.copy,'copyConfiguration',{},!state.bridgeRunning));root.append(section);
    }
    if(error || pending){const alert=element('p',pending?t('working'):t('failed'),'alert');alert.setAttribute('role','status');root.append(alert);}
    const tasks=state.tasks || [];
    if(!tasks.length){root.append(element('p',t('empty'),'empty'));return;}
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
    if(task.progress)detail.append(element('p',task.progress,'progress'));
    if(!state.bridgeRunning)detail.append(element('p',t('offline'),'notice'));
    if(task.pendingRequests?.length)detail.append(element('p',t('approval'),'notice'));
    if(task.recoveryRequired && task.state==='error')detail.append(element('p',t('recovery'),'notice'));
    if(task.error)detail.append(element('p',task.error,'task-error'));
    const taskActions=element('div',undefined,'actions');taskActions.append(button(t('open'),'openChat',{taskId:task.taskId},!task.chatId),button(t('cancel'),'cancel',{taskId:task.taskId},!state.bridgeRunning || (!['queued','running','waiting_approval'].includes(task.state) && !task.recoveryRequired)));detail.append(taskActions);
    if(task.report){
      const report=element('section',undefined,'report');report.append(element('h3',t('report')));
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
    input.addEventListener('input',()=>{drafts[task.taskId]=input.value;versions[task.taskId]=(versions[task.taskId] || 0)+1;persist();submit.disabled=pending || !state.bridgeRunning || !input.value.trim();});
    const submit=element('button',t('send'));submit.type='submit';submit.disabled=pending || !state.bridgeRunning || !input.value.trim();
    form.addEventListener('submit',event=>{event.preventDefault();if(!submit.disabled)action('continue',{taskId:task.taskId,clarification:input.value});});
    form.append(label,input,submit);detail.append(form);root.append(detail);
    if(focused==='clarification'){input.focus({preventScroll:true});input.setSelectionRange(start,end);}
    window.scrollTo(0,scroll);
  }
  window.addEventListener('message',event=>{
    const message=event.data;
    if(message?.type==='mcpState'){state=message.data;render();}
    if(message?.type==='mcpResult'){
      if(pending && message.requestId!==requestId)return;
      pending=false;error=message.ok?'':'failed';
      if(message.ok && message.configuration){configuration=message.configuration;copied=message.action==='copyConfiguration';}
      if(message.ok && message.action==='continue' && submission?.taskId===message.taskId && submission.version===(versions[message.taskId] || 0)){delete drafts[message.taskId];persist();}
      submission=null;requestId=null;
      render();
    }
  });
  api.postMessage({action:'ready'});
})();
