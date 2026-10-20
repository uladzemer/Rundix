// Keyed reconciliation: streamed tokens update their message, not the entire transcript.
class WorkbenchMessages {
  constructor(container, { markdown, icon, send, previewImage, openQuestions, footer }) {
    this.container = container;
    this.markdown = markdown;
    this.icon = icon;
    this.send = send;
    this.previewImage=previewImage;
    this.openQuestions=openQuestions;
    this.footer = footer;
    this.nodes = new Map();
    this.focusGroups = new Map();
    const russian = WorkbenchI18n.language === 'ru';
    const locale = russian ? 'ru-RU' : undefined;
    const clock = russian ? { hourCycle: 'h23' } : {};
    this.timeFormat = new Intl.DateTimeFormat(locale, {day: "2-digit", month: "2-digit", ...(russian ? {year: 'numeric'} : {}), hour: "2-digit", minute: "2-digit", ...clock});
    this.dateTimeFormat = new Intl.DateTimeFormat(locale, {year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short", ...clock});
  }
  action(label, iconName, handler) {
    const button = document.createElement("button");
    button.className = "icon-button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(this.icon(iconName));
    button.onclick = handler;
    return button;
  }
  update(state, { pending, scrollSnapshot } = {}) {
    const items=[...state.items];
    for(const record of state.questionHistory || []){
      if(record.origin!=='blocking')continue;
      const summary={id:'question-summary:'+record.id,type:'questionSummary',questionKey:record.id,
        text:record.skipped?WorkbenchI18n.t('Квиз пропущен'):record.questions.map(question=>question.question+'\n'+(record.answers[question.id] || '')).join('\n\n')};
      const index=items.findIndex(item=>item.id===record.parentItemId);
      if(index>=0)items.splice(index+1,0,summary);else items.push(summary);
    }
    state={...state,items};
    const beforeHeight = scrollSnapshot?.height ?? this.container.scrollHeight,
      beforeTop = scrollSnapshot?.top ?? this.container.scrollTop,
      nearBottom = scrollSnapshot?.following ?? (beforeHeight - beforeTop - this.container.clientHeight < 60),
      oldFirst = this.firstId,
      oldKey = this.key;
    this.firstId = state.items[0]?.id;
    this.key = state.key;
    this.bookmarkedIds = new Set(
      (state.bookmarks || []).map((item) => item.id),
    );
    if (oldKey !== state.key) {
      this.nodes.clear();
      this.focusGroups.clear();
      this.container.replaceChildren();
    }
    let desired = [];
    if (state.hasOlder) {
      if (!this.older) {
        this.older = document.createElement("button");
        this.older.textContent = WorkbenchI18n.t(
          "Загрузить более ранние сообщения",
        );
        this.older.onclick = () => this.send("older");
      }
      desired.push(this.older);
    }
    if (!state.items.length && !pending && (!this.footer || this.footer.hidden)) {
      if (!this.empty) {
        this.empty = document.createElement("div");
        this.empty.className = "empty";
        const mark = this.icon("assistant");
        mark.setAttribute("class", "ui-icon welcome-mark");
        this.empty.append(mark);
        for (const [tag, text] of [
          ["h1", WorkbenchI18n.t("Над чем работаем?")],
          ["p", WorkbenchI18n.t("Опишите задачу или добавьте файлы проекта.")],
          [
            "small",
            WorkbenchI18n.t("+ — файлы · / — команды · Enter — отправить"),
          ],
        ]) {
          const node = document.createElement(tag);
          node.textContent = text;
          this.empty.append(node);
        }
      }
      desired.push(this.empty);
    }
    const ids = new Set(state.items.map((item) => item.id));
    for (const [id, node] of this.nodes)
      if (!ids.has(id)) {
        node.article.remove();
        this.nodes.delete(id);
      }
    const labels = {
      commandExecution: WorkbenchI18n.t("Команда"),
      fileChange: WorkbenchI18n.t("Изменения файлов"),
      reasoning: WorkbenchI18n.t("Размышление"),
      webSearch: WorkbenchI18n.t("Поиск в интернете"),
      mcpToolCall: WorkbenchI18n.t("Инструмент MCP"),
      contextCompaction: WorkbenchI18n.t("Сжатие контекста"),
      plan: WorkbenchI18n.t("План"),
    };
    const statuses = {
      inProgress: WorkbenchI18n.t("выполняется"),
      completed: WorkbenchI18n.t("готово"),
      failed: WorkbenchI18n.t("ошибка"),
      declined: WorkbenchI18n.t("отклонено"),
    };
    for (const item of state.items) {
      const essential = ["userMessage", "agentMessage", "questionSummary"].includes(item.type);
      let node = this.nodes.get(item.id);
      if (!node) {
        const article = document.createElement(
          essential ? "article" : "details",
        );
        article.className =
          "item " +
          (item.type === "userMessage"
            ? "user"
            : item.type === "agentMessage"
              ? "assistant"
              : "tool");
        article.dataset.itemId = item.id;
        article.dataset.itemType = item.type;
        node = { article, content: document.createElement("div") };
        if (!essential) {
          node.summary = document.createElement("summary");
          article.append(node.summary);
        }
        if (item.type === 'userMessage') {
          node.card = document.createElement('div');
          node.card.className = 'user-message-card';
          node.card.append(node.content);
          article.append(node.card);
        } else article.append(node.content);
        if (essential && item.type!=='questionSummary') {
          node.actions = document.createElement("div");
          node.actions.className = "message-actions";
          if (item.type === "userMessage") {
            node.actions.classList.add("user-message-meta");
          }
          node.time = document.createElement("time");
          node.time.className = "message-time";
          node.time.hidden = true;
          article.append(node.time);
          node.copy = this.action(
            WorkbenchI18n.t("Копировать сообщение"),
            "copy",
            () => this.send("copyItem", { itemId: item.id }),
          );
          node.actions.append(node.copy);
          if (item.type === "agentMessage") {
            node.bookmark = this.action(
              WorkbenchI18n.t("Добавить закладку"),
              "bookmark",
              () =>
                this.send("bookmark", {
                  itemId: item.id,
                  enabled: !this.bookmarkedIds.has(item.id),
                }),
            );
            node.actions.append(node.bookmark);
            node.fork = this.action(
              WorkbenchI18n.t("Создать ветку до этого хода"),
              "branch",
              () => this.send("fork", { itemId: item.id }),
            );
            node.actions.append(node.fork);
          }
          (node.card || article).append(node.actions);
        }
        this.nodes.set(item.id, node);
      }
      if (node.time && node.timestamp !== item.timestamp) {
        node.timestamp = item.timestamp;
        const date = Number.isFinite(item.timestamp) ? new Date(item.timestamp) : null;
        const valid = date && !Number.isNaN(date.getTime());
        node.time.hidden = !valid;
        node.article.classList.toggle('has-time', !!valid);
        if (valid) {
          // Russian UI uses day/month/year and a 24-hour clock; the time zone stays local.
          node.time.dateTime = date.toISOString();
          node.time.textContent = this.timeFormat.format(date);
          node.time.title = this.dateTimeFormat.format(date);
          node.article.title = node.time.title;
        } else {
          node.time.removeAttribute("datetime");
          node.time.removeAttribute("title");
          node.article.removeAttribute("title");
        }
      }
      const metadata = JSON.stringify([
        item.exitCode,
        item.durationMs,
        item.command,
        item.tool,
      ]);
      const asyncRequest=item.type==='agentMessage'?WorkbenchQuestions.fromAsync(item):null;
      const questionSignature=asyncRequest?JSON.stringify(item.questions):null;
      if(asyncRequest && node.questionSignature!==questionSignature){
        node.questionSignature=questionSignature;
        node.questionLink=document.createElement('button');node.questionLink.type='button';node.questionLink.className='quiz-transcript-open';
        node.questionLink.onclick=()=>this.openQuestions?.('a:'+item.id);
      }
      if (
        node.text !== item.text ||
        node.status !== item.status ||
        node.metadata !== metadata ||
        node.changes !== JSON.stringify(item.changes) || node.images !== JSON.stringify(item.images) || node.renderedQuestions!==questionSignature
      ) {
        node.text = item.text;
        node.metadata = metadata;
        node.status = item.status;
        node.changes = JSON.stringify(item.changes);
        node.images=JSON.stringify(item.images);
        node.renderedQuestions=questionSignature;
        node.content.replaceChildren();
        if(item.type==='userMessage' && item.images?.length){
          const images=document.createElement('div');images.className='message-images';
          for(const [index,image] of item.images.entries()){
            const label=WorkbenchI18n.t('Изображение {0}',index+1);
            const card=document.createElement(image.preview?'button':'span');card.className='message-image';
            if(image.preview){
              card.type='button';card.setAttribute('aria-label',WorkbenchI18n.t('Открыть изображение {0}',index+1));
              const picture=document.createElement('img');picture.alt=label;picture.src=image.preview;picture.loading='lazy';
              picture.onerror=()=>{picture.remove();card.disabled=true;card.textContent=label;};
              card.append(picture);card.onclick=()=>this.previewImage?.(image.preview);
            }else card.textContent=label;
            images.append(card);
          }
          node.content.append(images);
        }
        if (item.type === "agentMessage") {
          if(asyncRequest)node.content.append(node.questionLink);
          else node.content.append(this.markdown(item));
        }
        else if(item.type==='questionSummary'){
          const button=document.createElement('button');button.type='button';button.className='quiz-transcript-open';button.textContent=WorkbenchI18n.t('Ответы на вопросы');
          button.onclick=()=>this.openQuestions?.(item.questionKey);
          const text=document.createElement('pre');text.textContent=item.text;node.content.append(button,text);
        }
        else if (item.type !== "fileChange") {
          const pre = document.createElement("pre");
          pre.textContent = item.text;
          if(item.text || !item.images?.length)node.content.append(pre);
        }
        for (const [index, change] of (item.changes || []).entries())
          node.content.append(
            WorkbenchChanges.block(change, {
              cwd: state.cwd,
              icon: this.icon,
              open: () => this.send("diff", { itemId: item.id, index }),
            }),
          );
        if (node.summary) {
          const summaryLabel = document.createElement("span");
          summaryLabel.className = "tool-label";
          summaryLabel.textContent =
            (labels[item.type] || item.type) +
            (item.tool ? " · " + item.tool : "") +
            (item.status
              ? " · " + (statuses[item.status] || item.status)
              : "") +
            (Number.isInteger(item.exitCode)
              ? " · " + WorkbenchI18n.t("Код выхода") + " " + item.exitCode
              : "") +
            (Number.isFinite(item.durationMs)
              ? " · " + (item.durationMs / 1000).toFixed(1) + " s"
              : "");
          const preview =
            item.type === "commandExecution"
              ? (item.command || item.text || "").split("\n")[0]
              : "";
          if (preview)
            summaryLabel.textContent += " \u00b7 " + preview.slice(0, 140);
          node.summary.replaceChildren(
            this.icon(
              {
                commandExecution: "code",
                fileChange: "file",
                reasoning: "effort",
                webSearch: "limits",
                mcpToolCall: "controls",
                contextCompaction: "history",
                plan: "plan",
              }[item.type] || "bolt",
            ),
            summaryLabel,
          );
          node.summary.classList.toggle(
            "danger-action",
            item.status === "failed" ||
              (Number.isInteger(item.exitCode) && item.exitCode !== 0),
          );
        }
      }
      if (node.fork) {
        node.fork.hidden = !item.turnId || item.phase === "commentary";
        node.fork.disabled = !!state.busy;
      }
      if (node.bookmark) {
        const marked = this.bookmarkedIds.has(item.id);
        node.bookmark.title = WorkbenchI18n.t(
          marked ? "Удалить закладку" : "Добавить закладку",
        );
        node.bookmark.setAttribute("aria-label", node.bookmark.title);
        node.bookmark.setAttribute("aria-pressed", String(marked));
        node.bookmark.classList.toggle("bookmarked", marked);
        node.bookmark.disabled = !!state.busy && !marked;
        node.bookmark.hidden = !item.text || item.phase === "commentary";
      }
      if(node.questionLink){
        const history=state.questionHistory?.find(record=>record.id==='a:'+item.id);
        const marker=state.asyncQuestionReplies?.[item.id];
        const confirmed=globalThis.WorkbenchQuestions.hasReply(state.items,item.id) || marker==='sent' || marker==='skipped';
        const status=confirmed?(history?.skipped || marker==='skipped'?WorkbenchI18n.t('Квиз пропущен'):WorkbenchI18n.t('Ответы сохранены')):marker==='queued'?WorkbenchI18n.t('Ответы в очереди'):marker==='unknown'?WorkbenchI18n.t('Доставка ответов не подтверждена'):WorkbenchI18n.t('Ожидает ответов');
        node.questionLink.textContent=WorkbenchI18n.t('Ответы на вопросы')+' · '+(item.questions?.length || 0)+' · '+status;
      }
      if (node.copy) node.copy.disabled = !item.text;
      node.article.dataset.status = item.status || "";
      node.article.classList.toggle('activity', !essential ||
        (item.type === 'agentMessage' && item.phase === 'commentary'));
      if (!essential && item.type === "reasoning" && !state.prefs.showThinking)
        continue;
      desired.push(node.article);
    }
    if(state.prefs.focus)desired=this.focused(desired,state,labels);
    if (pending) desired.push(pending);
    if (this.footer && !this.footer.hidden) desired.push(this.footer);
    // Connect only adjacent work steps; a user request or final answer ends the rail.
    for (const [index, article] of desired.entries()) {
      article.classList.toggle('activity-continues', article.classList.contains('activity') &&
        !!desired[index + 1]?.classList.contains('activity'));
    }
    const wanted = new Set(desired);
    for (const child of [...this.container.children])
      if (!wanted.has(child)) child.remove();
    for (const [index, child] of desired.entries())
      if (this.container.children[index] !== child)
        this.container.insertBefore(
          child,
          this.container.children[index] || null,
        );
    if (nearBottom) this.container.scrollTop = this.container.scrollHeight;
    else if (
      oldKey === state.key &&
      oldFirst &&
      this.firstId !== oldFirst &&
      ids.has(oldFirst)
    )
      this.container.scrollTop =
        beforeTop + this.container.scrollHeight - beforeHeight;
    else this.container.scrollTop = beforeTop;
  }
  focused(articles,state,labels){
    const items=new Map(state.items.map(item=>[String(item.id),item]));
    const result=[],used=new Set();let group=[],anchor='start';
    const lastUser=state.items.findLastIndex(item=>item.type==='userMessage');
    const positions=new Map(state.items.map((item,index)=>[String(item.id),index]));
    const flush=()=>{
      if(!group.length)return;
      const key=anchor+':'+group[0].dataset.itemId;used.add(key);
      let view=this.focusGroups.get(key);
      if(!view){
        const article=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('div');
        article.className='item focus-group activity';summary.className='focus-summary';body.className='focus-group-body';
        const count=document.createElement('span'),status=document.createElement('span'),errors=document.createElement('span');
        status.className='focus-status';errors.className='focus-errors';errors.hidden=true;
        summary.append(count,status,errors);
        const collapse=document.createElement('button');
        collapse.type='button';collapse.className='focus-collapse';
        collapse.textContent=WorkbenchI18n.t('Свернуть шаги')+' ↑';
        collapse.onclick=()=>{article.open=false;summary.focus();};
        article.append(summary,body,collapse);view={article,summary,body,count,status,errors};this.focusGroups.set(key,view);
      }
      const records=group.map(article=>items.get(article.dataset.itemId));
      const steps=records.filter(item=>!['reasoning','plan','agentMessage'].includes(item.type));
      const failed=item=>['failed','declined'].includes(item.status)||(Number.isInteger(item.exitCode)&&item.exitCode!==0);
      const lastId=group.at(-1).dataset.itemId;
      const active=records.some(item=>item.status==='inProgress') ||
        (state.busy && positions.get(lastId)>lastUser && lastId===String(state.items.at(-1)?.id));
      const completed=steps.filter(item=>!failed(item)&&item.status!=='inProgress').length;
      const failures=steps.filter(failed).length;
      const current=records.findLast(item=>item.status==='inProgress') || records.at(-1);
      const count=steps.length ? WorkbenchI18n.t('Шаги: {0} из {1}',completed,steps.length) : WorkbenchI18n.t('Ход работы');
      const status=' · '+(active ? (labels[current.type] || WorkbenchI18n.t('Работает')) : WorkbenchI18n.t('Завершено'));
      const errors=failures ? WorkbenchI18n.t('Ошибок: {0}',failures) : '';
      for(const [element,text] of [[view.count,count],[view.status,status],[view.errors,errors]])
        if(element.textContent!==text)element.textContent=text;
      view.errors.hidden=!failures;
      // Keep the explicit meaning of the compact counter available on hover.
      view.summary.title=steps.length ? WorkbenchI18n.t('Выполнено шагов: {0} из {1}',completed,steps.length) : '';
      view.article.classList.toggle('is-running',!!active);view.article.classList.toggle('has-errors',failures>0);
      const wanted=new Set(group);
      for(const child of [...view.body.children])if(!wanted.has(child))child.remove();
      for(const [index,child] of group.entries())if(view.body.children[index]!==child)view.body.insertBefore(child,view.body.children[index] || null);
      result.push(view.article);group=[];
    };
    for(const article of articles){
      const item=items.get(article.dataset.itemId);
      if(item && !['userMessage','agentMessage','questionSummary'].includes(item.type))group.push(article);
      else{flush();result.push(article);if(item?.type==='userMessage')anchor=String(item.id);}
    }
    flush();
    for(const [key,view] of this.focusGroups)if(!used.has(key)){view.article.remove();this.focusGroups.delete(key);}
    return result;
  }
  copied(itemId, codeIndex) {
    const article = this.nodes.get(itemId)?.article;
    if (!article) return;
    const button =
      codeIndex === undefined
        ? this.nodes.get(itemId).copy
        : article.querySelector(`[data-code-index="${codeIndex}"]`);
    if (!button) return;
    const title = button.title;
    button.title = WorkbenchI18n.t("Скопировано");
    button.setAttribute("aria-label", WorkbenchI18n.t("Скопировано"));
    button.classList.add("copied");
    setTimeout(() => {
      button.title = title;
      button.setAttribute("aria-label", title);
      button.classList.remove("copied");
    }, 1200);
  }
}
