(function(root) {
  const t = text => root.WorkbenchI18n.t(text);
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function create(request, answer, {paged=false}={}) {
    const form = element('form', undefined, 'quiz-form');
    const fields = [], draftFields = [];
    const pages=[],tabs=[];
    const navigation=element('div',undefined,'quiz-pages');
    form.questionTabs=navigation;
    if(paged)form.append(navigation);
    let page=0,readOnly=false,busy=false;
    for (const question of request.params.questions || []) {
      const group = element('fieldset', undefined, 'quiz-question');
      const index=pages.length;
      pages.push(group);
      if(paged){
        const tab=element('button',question.header || t('Вопрос {0}').replace('{0}',String(index+1)),'quiz-page-tab');
        tab.type='button';tab.onclick=()=>show(index);tabs.push(tab);navigation.append(tab);
      }
      group.append(element('legend', question.question));
      if (question.header && !paged) group.append(element('small', question.header, 'quiz-header'));
      const field = element('input');
      field.name = question.id;
      field.type = question.isSecret ? 'password' : 'text';
      field.required = true;
      field.maxLength = 20000;
      field.autocomplete = 'off';
      field.setAttribute('aria-label', question.question);
      const buttons = [];
      let multiple=false;
      const selected=new Set();
      const value=()=>multiple ? [...selected,field.value.trim()].filter(Boolean).join('\n') : field.value;
      const mode=element('button',t('Выбрать несколько'),'quiz-multiple');
      mode.type='button';mode.setAttribute('aria-pressed','false');
      mode.onclick=()=>{
        multiple=!multiple;
        if(multiple){
          const current=buttons.find(([,label])=>label===field.value);
          if(current){selected.add(current[1]);field.value='';}
        }else{
          field.value=valueFromSelection();selected.clear();
        }
        mode.setAttribute('aria-pressed',String(multiple));update();
        form.dispatchEvent(new Event('input',{bubbles:true}));
      };
      function valueFromSelection(){return [...selected,field.value.trim()].filter(Boolean).join('; ');}
      const choices = element('div', undefined, 'quiz-choices');
      for (const option of question.options || []) {
        const button = element('button', undefined, 'quiz-option');
        button.type = 'button';
        button.setAttribute('aria-pressed', 'false');
        button.append(element('strong', option.label));
        if (option.description) button.append(element('span', option.description, 'quiz-description'));
        // Recommendation comes from the model's label, never inferred from order.
        if (/recommended|рекоменд/i.test(option.label)) {
          button.classList.add('recommended');
          button.append(element('small', t('Рекомендую'), 'quiz-recommendation'));
        }
        button.onclick = () => {
          if(readOnly || busy)return;
          if(multiple){
            if(selected.has(option.label))selected.delete(option.label);
            else selected.add(option.label);
          }else field.value = option.label;
          field.dispatchEvent(new Event('input', {bubbles:true}));
          if(paged && !multiple && index===page && index<pages.length-1)
            show(index+1,true);
        };
        buttons.push([button, option.label]);
        choices.append(button);
      }
      if(buttons.length)group.append(mode);
      group.append(choices);
      const label = element('label', t(buttons.length ? 'Свой ответ или уточнение' : 'Ваш ответ'));
      label.append(field);
      const custom=element('details',undefined,'quiz-custom-answer');
      custom.append(element('summary',t('Свой ответ')),label);
      custom.open=!buttons.length;
      group.append(custom);
      const update = () => {
        field.required=!multiple || !selected.size;
        for (const [button, label] of buttons){
          const checked=multiple ? selected.has(label) : field.value===label;
          button.classList.toggle('is-checkbox',multiple);
          if(multiple){button.setAttribute('role','checkbox');button.setAttribute('aria-checked',String(checked));button.removeAttribute('aria-pressed');}
          else{button.removeAttribute('role');button.removeAttribute('aria-checked');button.setAttribute('aria-pressed',String(checked));}
        }
        submit.disabled = readOnly || busy || !fields.every(([, ,getValue]) => getValue().trim());
      };
      field.addEventListener('input', update);
      fields.push([question.id, field,value,()=>{selected.clear();multiple=false;mode.setAttribute('aria-pressed','false');custom.open=true;}]);
      draftFields.push({get:()=>question.isSecret ? null : ({value:field.value,multiple,selected:[...selected],open:custom.open}),
        set:draft=>{if(question.isSecret)return;field.value=draft.value || '';multiple=!!draft.multiple;selected.clear();
          for(const label of draft.selected || [])selected.add(label);
          custom.open=!!draft.open;mode.setAttribute('aria-pressed',String(multiple));update();}});
      form.append(group);
    }
    const submit = element('button', t('Отправить ответы'), 'primary');
    submit.type = 'submit';
    submit.disabled = true;
    const actions=element('div',undefined,'quiz-navigation');
    const back=element('button',t('Назад'),'quiz-back'),next=element('button',t('Далее'),'quiz-next');
    back.type=next.type='button';back.onclick=()=>show(page-1);next.onclick=()=>show(page+1);
    if(paged)actions.append(back,next);
    form.append(actions,submit);
    const hint=element('small',t('Esc — свернуть'),'quiz-hint');form.append(hint);
    function show(index,focusQuestion=false){
      page=Math.max(0,Math.min(pages.length-1,index));
      pages.forEach((group,i)=>{group.hidden=paged && i!==page;});
      tabs.forEach((tab,i)=>tab.setAttribute('aria-current',i===page?'step':'false'));
      back.disabled=busy || page===0;next.disabled=busy || page===pages.length-1;
      back.hidden=!paged || page===0;
      next.hidden=!paged || page===pages.length-1;
      if(focusQuestion){
        const heading=pages[page]?.querySelector('legend');
        if(heading){heading.tabIndex=-1;heading.focus();}
      }
    }
    form.setQuizState=options=>{
      readOnly=!!options.readOnly;busy=!!options.busy;
      for(const control of form.querySelectorAll('input,.quiz-option,.quiz-multiple'))control.disabled=readOnly || busy;
      for(const tab of tabs)tab.disabled=busy;
      submit.disabled=readOnly || busy || !fields.every(([, ,getValue])=>getValue().trim());
      show(page);
    };
    form.getDraft=()=>({fields:draftFields.map(field=>field.get()),page});
    form.restoreDraft=draft=>{draftFields.forEach((field,index)=>{if(draft.fields?.[index])field.set(draft.fields[index]);});show(draft.page || 0);};
    form.restoreAnswers=answers=>{
      for(const [id,field,,reset] of fields){reset();field.value=(answers?.[id] || '').replace(/\n/g,'; ');field.dispatchEvent(new Event('input'));}
    };
    show(0);
    form.onsubmit = event => {
      event.preventDefault();
      if (readOnly || busy || !fields.length || !fields.every(([, field,getValue]) => getValue().trim() && getValue().length<=20000 && field.checkValidity())) return;
      answer(Object.fromEntries(fields.map(([id, ,getValue]) => [id, getValue()])));
    };
    return form;
  }
  function fromAsync(item) {
    if (!Array.isArray(item.questions) || !item.questions.length || item.questions.length>3) return null;
    if (!item.questions.every(question=>typeof question.title==='string' &&
      (question.options==null || Array.isArray(question.options) && question.options.every(option=>typeof option==='string')))) return null;
    return {params:{questions:item.questions.map((question,index)=>({
      id:String(index),question:question.title,options:(question.options || []).map(label=>({label})),
    }))}};
  }
  root.WorkbenchQuestions = {create,fromAsync};
})(globalThis);
