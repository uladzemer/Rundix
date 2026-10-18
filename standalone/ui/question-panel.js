(function(root){
  const t=text=>root.WorkbenchI18n.t(text);
  function el(tag,text,className){
    const node=document.createElement(tag);
    if(text!==undefined)node.textContent=text;
    if(className)node.className=className;
    return node;
  }
  class QuestionPanel {
    constructor(send){
      this.send=send;this.views=new Map();this.key=null;this.session=null;this.sessions=new Map();
      this.element=el('section',undefined,'question-panel');this.element.hidden=true;
      const header=el('div',undefined,'question-panel-header');
      this.tabs=el('div',undefined,'question-panel-tabs');
      this.toggle=el('button',t('Ответы на вопросы'),'question-panel-toggle');this.toggle.type='button';
      this.toggle.onclick=()=>this.expand(this.body.hidden);
      this.close=el('button','×','question-panel-close');this.close.type='button';
      this.close.title=t('Закрыть и пропустить квиз');this.close.setAttribute('aria-label',this.close.title);
      this.close.onclick=()=>this.skip();header.append(this.tabs,this.toggle,this.close);
      this.body=el('div',undefined,'question-panel-body');
      this.body.id='question-panel-body';this.toggle.setAttribute('aria-controls',this.body.id);
      this.body.setAttribute('role','region');this.body.setAttribute('aria-label',t('Ответы на вопросы'));
      this.body.onkeydown=event=>{
        if(event.key==='Escape'){event.stopPropagation();this.expand(false);this.toggle.focus({preventScroll:true});}
      };
      this.selector=el('select',undefined,'question-panel-selector');this.selector.setAttribute('aria-label',t('Выбрать квиз'));
      this.selector.onchange=()=>this.open(this.selector.value);
      this.quizSwitcher=el('label',undefined,'question-panel-switcher');
      this.quizSwitcher.title=t('Выбрать квиз');
      this.quizSwitcherLabel=el('span');this.quizSwitcherLabel.setAttribute('aria-hidden','true');
      this.quizSwitcher.append(this.quizSwitcherLabel,this.selector);
      header.insertBefore(this.quizSwitcher,this.toggle);
      this.content=el('div',undefined,'question-panel-content');
      this.body.append(this.content);this.element.append(header,this.body);
    }
    expand(open){
      this.body.hidden=!open;this.toggle.setAttribute('aria-expanded',String(open));
      this.element.classList.toggle('is-expanded',open);
      if(open && this.element.classList.contains('is-answering') && document.activeElement?.closest('.composer'))
        this.element.querySelector('button:not(:disabled),input:not(:disabled)')?.focus({preventScroll:true});
      if(!open && this.views.get(this.key)?.record){
        this.historyOpen=false;this.key=null;this.element.hidden=true;
        if(this.returnFocus?.isConnected)this.returnFocus.focus({preventScroll:true});
      }
    }
    open(key){
      if(key && !this.views.has(key))return;
      if(key)this.key=key;
      this.historyOpen=!!this.views.get(this.key)?.record;
      if(this.historyOpen && !this.element.contains(document.activeElement))this.returnFocus=document.activeElement;
      this.element.hidden=false;
      this.render();this.expand(true);
    }
    submit(view,answers,skip=false){
      if(view.record || view.busy)return;
      view.busy=true;view.form.setQuizState({busy:true});this.render();
      this.send(view.action,{...view.target,answers,skip});
    }
    skip(){
      const view=this.views.get(this.key);
      if(!view || view.busy)return;
      if(view.record){this.expand(false);return;}
      this.submit(view,undefined,true);
      this.expand(false);
    }
    update(state){
      if(this.session!==state.key){
        if(this.session)this.sessions.set(this.session,{views:this.views,key:this.key,expanded:!this.body.hidden});
        const cached=this.sessions.get(state.key);
        this.views=cached?.views || new Map();this.key=cached?.key || null;this.session=state.key;
        this.historyOpen=false;
        this.expand(cached?.expanded || false);
        this.sessions.delete(state.key);
        while(this.sessions.size>10)this.sessions.delete(this.sessions.keys().next().value);
      }
      this.state=state;
      const known=new Set(this.views.keys());
      const entries=[];
      for(const request of state.requests || []){
        if(request.method==='item/tool/requestUserInput')entries.push({key:'b:'+(request.params.itemId || request.id),request,action:'answer',target:{id:request.id}});
      }
      for(const item of state.items || []){
        const request=item.type==='agentMessage'?root.WorkbenchQuestions.fromAsync(item):null;
        if(request && !state.asyncQuestionReplies?.[item.id])entries.push({key:'a:'+item.id,request,action:'answerAsync',target:{itemId:item.id}});
      }
      for(const record of state.questionHistory || [])entries.push({key:record.id,record,request:{params:{questions:record.questions}}});
      const valid=new Set(entries.map(entry=>entry.key));
      for(const key of this.views.keys())if(!valid.has(key))this.views.delete(key);
      for(const entry of entries){
        let view=this.views.get(entry.key);
        const signature=JSON.stringify(entry.request.params.questions);
        if(!view || view.signature!==signature){
          view={...entry,signature};
          view.form=root.WorkbenchQuestions.create(entry.request,answers=>this.submit(view,answers),{paged:true});
          this.views.set(entry.key,view);
        }
        Object.assign(view,entry);
        view.busy=entry.action==='answerAsync' && !!state.asyncQuestionSending;
        if(entry.record && view.restored!==entry.record){view.form.restoreAnswers(entry.record.answers);view.restored=entry.record;}
        view.form.setQuizState({readOnly:!!entry.record,busy:view.busy});
      }
      const prior=this.key;
      if(this.views.get(this.key)?.record){
        const newest=entries.findLast(entry=>!entry.record && !known.has(entry.key));
        if(newest){this.key=newest.key;this.historyOpen=false;}
      }
      if(!this.views.has(this.key) || this.views.get(this.key)?.record && !this.historyOpen)
        this.key=entries.findLast(entry=>entry.action==='answer')?.key || entries.findLast(entry=>!entry.record)?.key || null;
      this.element.hidden=!this.key;
      if(!this.key){
        if(this.element.contains(document.activeElement))document.querySelector('textarea')?.focus({preventScroll:true});
        return;
      }
      this.render();
      if(prior!==this.key)this.expand(!this.views.get(this.key).record);
    }
    render(){
      const view=this.views.get(this.key);if(!view)return;
      this.element.classList.toggle('is-answering',!view.record);
      this.selector.replaceChildren();
      for(const [key,entry] of this.views){
        const option=el('option',(entry.request.params.questions[0]?.question || t('Ответы на вопросы')).slice(0,100));
        option.value=key;this.selector.append(option);
      }
      this.selector.value=this.key;this.quizSwitcher.hidden=this.views.size<2;
      this.quizSwitcherLabel.textContent=t('Квизы: {0}').replace('{0}',String(this.views.size))+' ▾';
      const count=view.request.params.questions.length;
      const status=view.record?view.record.status==='queued'?t('Ответы в очереди'):view.record.skipped?t('Квиз пропущен'):t('Ответы сохранены'):view.busy?t('Отправляю ответы…'):t('Ожидает ответов');
      this.toggle.textContent=t('Ответы на вопросы')+' · '+count+' · '+status;
      this.toggle.title=this.toggle.textContent;
      this.toggle.setAttribute('aria-label',this.toggle.textContent);
      if(view.form.questionTabs.parentNode!==this.tabs)this.tabs.replaceChildren(view.form.questionTabs);
      if(view.form.parentNode!==this.content)this.content.replaceChildren(view.form);
      this.close.hidden=false;this.close.disabled=!!view.busy;
      this.close.title=t(view.record?'Закрыть':'Закрыть и пропустить квиз');
      this.close.setAttribute('aria-label',this.close.title);
    }
  }
  root.WorkbenchQuestionPanel=QuestionPanel;
})(globalThis);
