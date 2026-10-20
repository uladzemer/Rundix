/* global acquireVsCodeApi, WorkbenchI18n, WorkbenchQuestions, WorkbenchMarkdownView, WorkbenchMarkdown */
(()=>{
  const api=acquireVsCodeApi(),root=document.getElementById('app');
  let saved=api.getState() || {},state=null,initialized=false,pending=null,version=0;
  let traversal=null,historyPending=false;
  let draft=saved.draft || '',questionDrafts=saved.questionDrafts || {},attempts=saved.attempts || {};
  const requests=new Map(),items=new Map();
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
  const tr=(en,ru)=>state?.language==='ru'?ru:en;
  const title=el('h1','Rundix'),owner=el('p',null,'service-note'),status=el('p'),notice=el('p',null,'notice'),error=el('p',null,'alert');
  const transcript=el('section',null,'transcript'),questions=el('section',null,'requests'),composer=el('form',null,'composer');
  const input=el('textarea'),send=el('button'),cancel=el('button'),refresh=el('button'),older=el('button');
  input.id='service-draft';input.maxLength=100000;input.value=draft;send.type='submit';cancel.type=refresh.type=older.type='button';
  const label=el('label');label.htmlFor=input.id;composer.append(label,input,send);
  const controls=el('div',null,'actions');controls.append(refresh,cancel,older);
  root.append(title,owner,status,notice,error,controls,transcript,questions,composer);
  const markdown=new WorkbenchMarkdownView({icon:()=>el('span','⧉'),send:(action,payload)=>{
    if(action==='copyItem'){
      const item=items.get(payload.itemId)?.item;if(!item)return;
      const text=payload.codeIndex==null?item.text:WorkbenchMarkdown.codeBlocks(item.text)[payload.codeIndex];
      api.postMessage({action:'copyText',text});
    }else api.postMessage({action,...payload});
  }});
  function persist(){
    saved={spaceId:state?.spaceId || saved.spaceId,taskId:state?.taskId || saved.taskId,draft,questionDrafts,attempts};
    api.setState(saved);return saved;
  }
  const saveDraft=()=>{api.postMessage({action:'draft',state:persist()});};
  const enabled=()=>!!state && !state.readOnly;
  function busy(){
    send.disabled=!!pending || !enabled() || !input.value.trim();
    cancel.disabled=!!pending || !enabled() || !['queued','running','waiting_limit','waiting_approval'].includes(state?.state);
    for(const view of requests.values()){
      const disabled=!!pending || !enabled() || !!view.request.displayOnly;
      view.quiz?.setQuizState({busy:disabled});
      for(const control of view.section.querySelectorAll('input,textarea,button'))if(!view.quiz || !view.quiz.contains(control))control.disabled=disabled;
    }
  }
  function mutate(action,payload){
    if(pending || !enabled())return;
    const key=JSON.stringify({action,...payload});
    const id=attempts[key] || Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
    attempts[key]=id;pending={id,key,action,version};saveDraft();error.textContent='';busy();
    api.postMessage({action,requestId:id,...payload});
  }
  input.addEventListener('input',()=>{draft=input.value;version++;saveDraft();busy();});
  composer.addEventListener('submit',event=>{event.preventDefault();if(!send.disabled)mutate('continue',{text:input.value});});
  cancel.onclick=()=>mutate('cancel',{});refresh.onclick=()=>api.postMessage({action:'refresh'});
  older.onclick=()=>{if(historyPending)return;historyPending=true;older.disabled=true;api.postMessage({action:'older',cursor:traversal.cursor});};
  function showItems(rows,prepend=false){
    const atBottom=scrollY+innerHeight>=document.documentElement.scrollHeight-80;
    for(const item of rows){
      const signature=JSON.stringify(item),existing=items.get(item.id);
      if(existing?.signature===signature)continue;
      const article=el('article',null,'message '+(item.type==='userMessage'?'user':'agent'));
      article.dataset.itemId=item.id;article.append(el('strong',item.type==='userMessage'?tr('You','Вы'):item.type==='agentMessage'?'Codex':item.type),markdown.render(item));
      if(item.truncated)article.append(el('small',tr('Display shortened','Отображение сокращено')));
      if(existing)existing.node.replaceWith(article);else if(prepend)transcript.insertBefore(article,transcript.firstChild);else transcript.append(article);
      items.set(item.id,{node:article,signature,item});
    }
    if(atBottom && !prepend)scrollTo(0,document.documentElement.scrollHeight);
  }
  function requestView(request){
    const section=el('section',null,'approval');section.append(el('h2',tr('Your decision','Ваше решение')));
    const view={section,request},answer=approval=>mutate('answer',{approval:{id:request.id,...approval}});
    if(request.displayOnly){section.append(el('p',tr('Request is too large to display. Read and answer it through get_task / continue_task.','Запрос слишком велик для отображения. Прочитайте его через get_task и ответьте через continue_task.')));return view;}
    const question=request.method==='rundix/asyncQuestion'?WorkbenchQuestions.fromAsync({questions:request.params.questions}):request;
    if(['item/tool/requestUserInput','rundix/asyncQuestion'].includes(request.method)){
      const quiz=WorkbenchQuestions.create(question,answers=>answer({answers}));view.quiz=quiz;
      if(questionDrafts[request.id])quiz.restoreDraft(questionDrafts[request.id]);
      quiz.addEventListener('input',()=>{questionDrafts[request.id]=quiz.getDraft();saveDraft();});
      const skip=el('button',tr('Skip questions','Пропустить вопросы'));skip.type='button';skip.onclick=()=>answer({skip:true});
      section.append(quiz,skip);
    }else{
      const params=request.params || {};
      section.append(el('pre',JSON.stringify(params,null,2),'configuration-json'));
      let content;
      if(request.method==='mcpServer/elicitation/request' && params.mode==='form'){
        content=el('textarea');content.placeholder=tr('Form response (JSON object)','Ответ формы (JSON-объект)');content.value=questionDrafts[request.id]?.content || '{}';
        content.oninput=()=>{questionDrafts[request.id]={content:content.value};saveDraft();};section.append(content);
      }
      const decisions=Array.isArray(params.availableDecisions)?params.availableDecisions:['accept','decline','cancel'];
      for(const decision of decisions.filter(value=>['accept','decline','cancel'].includes(value))){
        const button=el('button',({accept:tr('Approve','Разрешить'),decline:tr('Decline','Отклонить'),cancel:tr('Cancel','Отменить')})[decision]);button.type='button';
        button.onclick=()=>{try{answer({decision,...(content && decision==='accept'?{content:JSON.parse(content.value)}:{})});}catch{error.textContent=tr('Enter valid JSON.','Введите корректный JSON.');}};section.append(button);
      }
    }
    return view;
  }
  function update(data){
    if(!data){error.textContent=tr('Service disconnected. Draft preserved.','Сервис отключён. Черновик сохранён.');state=null;traversal=null;historyPending=false;transcript.replaceChildren();items.clear();questions.replaceChildren();requests.clear();busy();return;}
    if(saved.taskId && (saved.taskId!==data.taskId || saved.spaceId!==data.spaceId))return;
    if(state?.generation===data.generation && state.viewRevision>data.viewRevision)return;
    if(state && state.generation!==data.generation){transcript.replaceChildren();items.clear();questions.replaceChildren();requests.clear();}
    if(!traversal || traversal.generation!==data.generation || traversal.chatId!==data.chatId){traversal={generation:data.generation,chatId:data.chatId,cursor:data.cursor,started:false};historyPending=false;}
    else if(!traversal.started)traversal.cursor=data.cursor;
    state=data;WorkbenchI18n.setLanguage(state.language);document.documentElement.lang=state.language;
    if(!initialized){
      if(!Object.hasOwn(saved,'draft') && data.draftState){draft=data.draftState.draft || '';questionDrafts=data.draftState.questionDrafts || {};attempts=data.draftState.attempts || {};input.value=draft;}
      initialized=true;
    }
    persist();title.textContent=state.title;owner.textContent=state.readOnly?tr('Legacy history · read only','История старой версии · только чтение'):tr('Service-owned task · Rundix','Задача фонового сервиса · Rundix');
    const labels={queued:tr('Queued','В очереди'),running:tr('Running','Выполняется'),waiting_approval:tr('Waiting for approval','Ожидает подтверждения'),waiting_limit:tr('Waiting for limits','Ожидает лимитов'),completed:tr('Completed','Завершена'),error:tr('Error','Ошибка'),cancelled:tr('Cancelled','Отменена')};
    status.textContent=(labels[state.state] || state.state)+(state.progress?' · '+state.progress:'');
    notice.hidden=!state.historyTruncated && !state.itemsTruncated;notice.textContent=tr('Showing a bounded transcript. Large items are shortened.','Показан ограниченный фрагмент истории. Большие элементы сокращены.');
    error.textContent=state.error || '';label.textContent=tr('Continue in this task','Продолжить задачу');send.textContent=tr('Send continuation','Отправить уточнение');cancel.textContent=tr('Cancel task','Отменить задачу');refresh.textContent=tr('Refresh','Обновить');older.textContent=tr('Earlier messages','Ранние сообщения');older.hidden=!traversal.cursor;older.disabled=historyPending;
    showItems(state.items || []);
    const valid=new Set((state.pendingRequests || []).map(request=>String(request.id)));
    for(const [id,view]of requests)if(!valid.has(id)){view.section.remove();requests.delete(id);}
    for(const request of state.pendingRequests || []){
      const id=String(request.id),signature=JSON.stringify(request);let view=requests.get(id);
      if(!view || view.signature!==signature){view?.section.remove();view=requestView(request);view.signature=signature;requests.set(id,view);questions.append(view.section);}
    }
    busy();
    if(state.closed)api.postMessage({action:'closeReady',state:persist()});
  }
  window.addEventListener('message',event=>{
    const message=event.data;
    if(message?.type==='serviceChat')update(message.data);
    if(message?.type==='chatHistory' && state){showItems([...message.data.items].reverse(),true);traversal.cursor=message.data.cursor;traversal.started=true;historyPending=false;older.hidden=!traversal.cursor;older.disabled=false;}
    if(message?.type==='chatResult' && pending?.id===message.requestId){
      if(message.ok){
        delete attempts[pending.key];
        if(pending.action==='continue' && pending.version===version){draft='';input.value='';}
        if(pending.action==='answer'){const payload=JSON.parse(pending.key);delete questionDrafts[payload.approval.id];}
      }else error.textContent=tr('Action failed. Draft and request ID preserved; retry explicitly.','Действие не выполнено. Черновик и request ID сохранены; повторите явно.');
      pending=null;saveDraft();busy();
    }
    if(message?.type==='chatResult' && !message.ok && !message.requestId)error.textContent=tr('Action failed. Draft preserved.','Действие не выполнено. Черновик сохранён.');
    if(message?.type==='chatResult' && message.action==='older' && !message.ok){historyPending=false;older.disabled=false;}
  });
  busy();api.postMessage({action:'ready'});
})();
