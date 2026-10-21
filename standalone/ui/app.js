// Independent local UI. Uses only our own DOM and the VS Code webview message API.
const vscode = acquireVsCodeApi();
const previous = vscode.getState() || {};
let state = {
  key: previous.key,
  name: "Rundix",
  items: [],
  requests: [],
  models: [],
  prefs: { focus: false, showThinking: true, ide: false, access: "workspace" },
  ...previous.state,
};
let menu = null,
  menuKind = null,
  reasoningView = null,
  modelListRender = null,
  commandMenuRender = null,
  clientMenuRender = null,
  pendingModel = null,
  history = [],
  draft = previous.draft || "",
  search = "",
  sending = false,
  hydrated = false,
  historyCursor = null,
  historyScope = previous.historyScope || null,
  historyListRender = null,
  historyQuery = "",
  historyTimer,
  historyGeneration = 0;
const quizDrafts = new Map((previous.quizDrafts || []).flatMap(([key,saved])=>{
  try{
    const questions=JSON.parse(saved.signature);
    return [[key,{...saved,draft:{...saved.draft,fields:questions.map((question,index)=>question.isSecret ? null : saved.draft.fields?.[index])}}]];
  }catch{return [];}
}));
const queuedDrafts = new Map(previous.queuedDrafts || []);
const approvalDrafts = new Map();
const pendingSends = new Map();
const pendingPreviews = new Map();
// Submitted text stays in the textarea for draft reconciliation, but is hidden
// while it is in flight; typing over it replaces it (see `beforeinput`).
const parkedSends = new Map();
const displacedSends = new Map();
function composerParked() {
  const text=parkedSends.get(state.key);
  return !!text && input.value===text && pendingSends.get(state.key)===text;
}
const quotaDismissals=new Map(Array.isArray(previous.quotaDismissals)?previous.quotaDismissals:[]);
const reviewDismissals = new Set(Array.isArray(previous.reviewDismissals) ? previous.reviewDismissals.filter(key => typeof key === 'string').slice(-64) : []);
const pendingClipboardImages=new Set();
let imageViewer=null;
function showImagePreview(src){
  close();
  if(!imageViewer){
    imageViewer=el('dialog',undefined,'image-viewer');
    imageViewer.setAttribute('aria-label',WorkbenchI18n.t('Просмотр изображения'));
    const picture=el('img');picture.alt=WorkbenchI18n.t('Вставленное изображение');
    const dismiss=el('button','×','image-viewer-close');dismiss.type='button';dismiss.setAttribute('aria-label',WorkbenchI18n.t('Закрыть просмотр'));dismiss.title=WorkbenchI18n.t('Закрыть просмотр');
    dismiss.onclick=()=>imageViewer.close();
    imageViewer.append(picture,dismiss);
    imageViewer.addEventListener('click',event=>{if(event.target===imageViewer)imageViewer.close();});
    imageViewer.addEventListener('close',()=>{picture.removeAttribute('src');input.focus();});
    document.body.append(imageViewer);
  }
  imageViewer.querySelector('img').src=src;
  if(!imageViewer.open)imageViewer.showModal();
}
function accountSignature() {
  return JSON.stringify([state.account, state.connection, state.limits, state.loginPending, state.authBusy, state.busy, state.compacting]);
}
let fileResults = [],
  fileListView = null,
  fileTimer,
  filesGeneration = 0,
  mention = null;
let modeView = null,
  fastView = null,
  pendingEffort = null;
let commandMenuSignature = "",
  cliMenuSignature = "",
  accountMenuSignature = "",
  limitsMenuSignature = "",
  inputSizeSignature = "";
const toggles = new WorkbenchToggles({
  owner: () => state.key,
  onTimeout() {
    state.error = WorkbenchI18n.t('Не удалось подтвердить изменение настройки. Проверьте её текущее состояние.');
    render();
  },
});
window.addEventListener('pagehide', () => toggles.reset(), { once: true });
function commandsSignature() {
  return JSON.stringify([
    state.model,
    state.models,
    state.prefs,
    state.effort,
    state.busy,
    state.id,
    state.group,
    state.account,
    state.chatWidth,
    state.contextDisplay,
    state.preflight?.enabled,
  ]);
}
let skills = [],
  skillsQuery = "",
  skillsLoading = false,
  skillsErrors = 0,
  skillsGeneration = 0,
  selectedBookmark = null,
  bookmarksQuery = "",
  bookmarksSignature = "",
  pendingReveal = null;
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
function icon(name) {
  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  const official = globalThis.WorkbenchIcons?.[name];
  if (official) {
    for (const [key, value] of Object.entries(official.root))
      if (!["xmlns", "width", "height"].includes(key))
        svg.setAttribute(key, value);
    svg.setAttribute(
      "class",
      "ui-icon official-icon" +
        (official.root.stroke
          ? " icon-outlined"
          : official.root.fill === "currentColor"
            ? " icon-filled"
            : ""),
    );
    svg.setAttribute("aria-hidden", "true");
    for (const attributes of official.paths) {
      const shape = document.createElementNS(ns, "path");
      for (const [key, value] of Object.entries(attributes))
        shape.setAttribute(key, value);
      svg.append(shape);
    }
    return svg;
  }
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ui-icon");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(ns, "path");
  shape.setAttribute(
    "d",
    {
      limits: "M3 18a10 10 0 1 1 18 0M12 13l5-5M5 18h14",
      down: "M12 5v14M5 12l7 7 7-7",
      file: "M5 3h9l5 5v13H5zM14 3v6h5",
      newchat:
        "M20 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14l4-4h5M18 14v8M14 18h8",
      bookmark: "M6 3h12v18l-6-4-6 4z",
      assistant:
        "M6 6h12v13H6zM12 3v3M9 10l-2 2 2 2M15 10l2 2-2 2M8 19v3M16 19v3M3 10v5M21 10v5",
      hand: "M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v6c0 4-2 7-6 7h-1c-2 0-3-1-4-2l-5-6a1.5 1.5 0 0 1 2-2l2 2",
      code: "m8 6-6 6 6 6M16 6l6 6-6 6M14 4l-4 16",
      plan: "M8 4h8v3H8zM8 5H5v16h14V5h-3M8 12h8M8 16h5",
      bolt: "m13 2-9 12h7l-1 8 10-13h-7z",
      controls: "M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M10 16v4",
      effort: "M5 8v8M8 5v14M16 5v14M19 8v8M8 12h8",
      rocket:
        "M14 4c2-2 6-2 6-2s0 4-2 6l-7 7-5-5zM6 10H3l-2 5h6M11 15v6l5-2v-5M5 17l-3 5 5-3",
      plus: "M12 5v14M5 12h14",
      slash:
        "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2M15 6 9 18",
      send: "M12 19V5M5 12l7-7 7 7",
      stop: "M6 6h12v12H6z",
      close: "m6 6 12 12M18 6 6 18",
      copy: "M8 8h12v12H8zM16 8V4H4v12h4",
      branch: "M6 4v10a4 4 0 0 0 4 4h8M14 14l4 4-4 4M6 4l-3 3m3-3 3 3",
      history: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2",
    }[name],
  );
  svg.append(shape);
  return svg;
}
const root = document.getElementById("app");
const sessionTabs = new WorkbenchTabs({
  icon,
  send,
  closeMenus: () => close(),
});
const activityView = new WorkbenchActivity({ icon });
const activity = activityView.element;
window.addEventListener('pagehide', () => activityView.dispose(), { once: true });
const messages = el("section", undefined, "messages");
messages.setAttribute("aria-label", WorkbenchI18n.t("Переписка"));
const transcriptScroll = new WorkbenchTranscriptScroll(messages);
window.addEventListener('pagehide', () => transcriptScroll.dispose(), { once: true });
const messageList = new WorkbenchMessages(messages, {
  footer: activity,
  markdown: messageContent,
  icon,
  send,
  previewImage:showImagePreview,
  openQuestions:key=>questionPanel.open(key),
});
const timeline = el("div", undefined, "timeline"),
  jump = el("button", undefined, "jump-latest icon-button");
jump.type = "button";
jump.title = WorkbenchI18n.t("К последним сообщениям");
jump.setAttribute("aria-label", jump.title);
jump.append(icon("down"));
jump.hidden = true;
timeline.append(messages, jump);
function updateJump() {
  jump.hidden =
    messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
}
jump.onclick = () => {
  transcriptScroll.toBottom();
  updateJump();
};
messages.addEventListener("scroll", updateJump, { passive: true });
const alerts = el("section", undefined, "alerts");
alerts.setAttribute("aria-live", "polite");
function updateActivity() { activityView.update(state, { sending }); }
const composer = el("section", undefined, "composer"),
  attachments = el("div", undefined, "attachments"),
  input = el("textarea");
input.placeholder = WorkbenchI18n.t("Что нужно сделать в этом проекте?");
input.setAttribute("aria-label", WorkbenchI18n.t("Сообщение Rundix"));
input.rows = 1;
input.value = draft;
const footer = el("footer"),
  left = el("div", undefined, "footer-left"),
  right = el("div", undefined, "footer-right");
function button(text, label, handler, parent = left) {
  const b = el("button", text);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", handler);
  parent.append(b);
  return b;
}
const attach = button("", WorkbenchI18n.t("Добавить файлы"), () =>
  open("attach"),
);
attach.className = "icon-button";
attach.append(icon("plus"));
const slash = button("", WorkbenchI18n.t("Команды (/)"), () =>
  open("commands"),
);
slash.className = "icon-button";
slash.append(icon("slash"));
const model = button(
  WorkbenchI18n.t("Подключение…"),
  WorkbenchI18n.t("Модель"),
  () => open("model"),
);
const ide = button("IDE", WorkbenchI18n.t("Контекст IDE"), () =>
  send("preferences", { ide: !state.prefs.ide }),
);
const access = button(
  WorkbenchI18n.t("Проект"),
  WorkbenchI18n.t("Режим доступа"),
  () => open("access"),
  right,
);
const contextButton = button(
  "",
  WorkbenchI18n.t("Сжать контекст"),
  () => {
    send("compact");
    close();
  },
  right,
);
contextButton.className = "icon-button context-button";
const contextSvg = document.createElementNS(
  "http://www.w3.org/2000/svg",
  "svg",
);
contextSvg.setAttribute("viewBox", "0 0 40 40");
contextSvg.setAttribute("class", "context-ring");
contextSvg.setAttribute("aria-hidden", "true");
const circles = ["context-track", "context-fill"].map((cls) => {
  const circle = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "circle",
  );
  for (const [key, value] of Object.entries({
    cx: 20,
    cy: 20,
    r: 18,
    pathLength: 100,
    class: cls,
  }))
    circle.setAttribute(key, value);
  contextSvg.append(circle);
  return circle;
});
contextButton.append(contextSvg);
const contextValue = el("span", "?", "context-value");
contextButton.append(contextValue);
left.insertBefore(contextButton, ide);
const limitsButton = button("", WorkbenchI18n.t("Лимиты"), () =>
  open("limits"),
);
limitsButton.className =
  "quiet-button dropdown limits-button local-work-button";
limitsButton.setAttribute("aria-haspopup", "dialog");
limitsButton.append(
  icon("limits"),
  el("span", WorkbenchI18n.t("Лимиты")),
);
limitsButton.title = WorkbenchI18n.t("Лимиты аккаунта");
const submit = button(
  "↑",
  WorkbenchI18n.t("Отправить"),
  () => submitText(),
  right,
);
const stop=button('',WorkbenchI18n.t('Остановить'),()=>send('stop'),right);
stop.className='icon-button stop-button';stop.append(icon('stop'));stop.hidden=true;
const enqueue=button(WorkbenchI18n.t('В очередь'),WorkbenchI18n.t('Отправить после текущего ответа'),()=>submitText('enqueue'),right);
enqueue.className='quiet-button enqueue-button';enqueue.hidden=true;
access.className = "quiet-button dropdown";
ide.className = "quiet-button";
model.className = "model-button dropdown";
submit.className = "icon-button submit-button";
function updateSubmitState() {
  submit.disabled = sending || composerParked() || !!pendingModel || !!pendingEffort || pendingClipboardImages.size>0 || (!input.value.trim() && !state.attachments?.some(file=>file.kind==='image'));
  enqueue.disabled=submit.disabled;enqueue.hidden=true;
  stop.hidden=!state.busy;
  submit.replaceChildren(icon('send'));
  submit.title=WorkbenchI18n.t('Отправить');
  submit.setAttribute('aria-label',submit.title);
}
left.append(access);
right.replaceChildren(model, contextButton, ide, enqueue, stop, submit);
ide.replaceChildren(
  icon("code"),
  el("span", WorkbenchI18n.t("Контекст IDE"), "ide-label"),
);
const brand = el("div", undefined, "empty-brand");
brand.append(icon("rundix"), el("span", "Rundix"));
brand.setAttribute("aria-hidden", "true");
footer.append(left, right);
composer.append(attachments, input, footer);
const reviewBar = el("section", undefined, "review-bar");
reviewBar.setAttribute('aria-label', WorkbenchI18n.t('Изменённые файлы'));
const reviewOpen = button('', WorkbenchI18n.t('Посмотреть изменения'), () => open('changes', true, currentReviewItems()));
reviewOpen.className = 'review-open';
const reviewClose = button('×', WorkbenchI18n.t('Скрыть панель изменённых файлов'), () => {
  reviewDismissals.add(reviewBar.dataset.dismissalKey);
  while (reviewDismissals.size > 64) reviewDismissals.delete(reviewDismissals.values().next().value);
  renderReview();persist();input.focus();
});
reviewClose.className = 'icon-button review-close';
reviewBar.append(reviewOpen, reviewClose);
const quotaWarningView = new WorkbenchQuotaWarningView({ el, button, open, dismissals: quotaDismissals, onDismiss: persist });
const quotaWarning = quotaWarningView.element;
window.addEventListener('pagehide', () => quotaWarningView.dispose(), { once: true });
reviewBar.hidden = true;
const composerDock = el("section", undefined, "composer-dock");
const queuedMessages=el('section',undefined,'queued-messages');queuedMessages.setAttribute('aria-label',WorkbenchI18n.t('Очередь сообщений'));queuedMessages.hidden=true;
const queuedEditor = new WorkbenchQueuedEditor({ send, drafts: queuedDrafts, onDraft: persist, focusComposer: () => input.focus() });
window.addEventListener('pagehide', () => queuedEditor.dispose(), { once: true });
const localBar = el("div", undefined, "local-work-bar");
localBar.append(limitsButton,quotaWarning);
const questionPanel=new WorkbenchQuestionPanel(send, { drafts: quizDrafts, onDraft: persist });
const taskPreflight=new WorkbenchTaskPreflight(send);
composerDock.append(questionPanel.element,taskPreflight.element,reviewBar, queuedMessages, composer, localBar);
const menuTriggers = new Set([attach, slash, model, access, limitsButton]);
root.append(
  sessionTabs.element,
  brand,
  timeline,
  alerts,
  composerDock,
);

function renderQuotaWarning() {
  quotaWarningView.render(state);
}
function currentReviewItems() {
  const latestTurnId=state.turnId || state.items.findLast(item=>item.turnId)?.turnId;
  const lastUserIndex=state.items.findLastIndex(item=>item.type==='userMessage');
  const currentItems=latestTurnId
    ? state.items.filter(item=>item.turnId===latestTurnId)
    : state.items.slice(lastUserIndex+1);
  // Keep past changes in the transcript, not attached to a later task's composer.
  const starting=pendingPreviews.has(state.key) || state.busy && !state.turnId;
  return starting ? [] : currentItems.filter(item=>item.type==='fileChange');
}
function renderReview() {
  const items = currentReviewItems();
  const changes=items.flatMap(item=>item.changes || []);
  const owner = items[0]?.turnId || state.items.findLast(item => item.type === 'userMessage')?.id || items[0]?.id;
  const dismissalKey = JSON.stringify([state.key, owner]);
  reviewBar.dataset.dismissalKey = dismissalKey;
  reviewBar.hidden = !changes.length || reviewDismissals.has(dismissalKey);
  composerDock.classList.toggle("has-changes", !reviewBar.hidden);
  if (reviewBar.hidden) return;
  const count = new Set(changes.map((change) => change.path)).size;
  const totals = changes.reduce(
    (sum, change) => {
      const stats = WorkbenchChanges.stats(change.diff);
      return {
        added: sum.added + stats.added,
        removed: sum.removed + stats.removed,
      };
    },
    { added: 0, removed: 0 },
  );
  reviewOpen.replaceChildren(
    icon("file"),
    el("span", WorkbenchI18n.t("Изменено файлов: {0}", count)),
    el("span", "+" + totals.added, "diff-added"),
    el("span", "−" + totals.removed, "diff-removed"),
    el("span", WorkbenchI18n.t("Посмотреть изменения"), "review-link"),
  );
}
function send(action, payload = {}) {
  vscode.postMessage({
    action,
    sessionKey: state.key,
    ...([
      "activateTab",
      "closeTab",
      "new",
      "open",
      "reopen",
      "beside",
      "newWindow",
      "openLast",
      "continueWindow",
      "fork",
      "forkTab",
      "moveTab",
      "mcpPanel",
    ].includes(action)
      ? { currentDraft: input.value }
      : {}),
    ...payload,
  });
}
const localDrafts = { ...(previous.drafts || {}) };
const composerDrafts = new WorkbenchComposerDrafts(previous.composerDrafts);
function persist() {
  if (state.key) localDrafts[state.key] = input.value;
  composerDrafts.prune(state.key,state.tabs?.map(tab=>tab.key),localDrafts);
  vscode.setState({
    hostKey: state.hostKey,
    key: state.key,
    draft: input.value,
    drafts: localDrafts,
    composerDrafts: composerDrafts.records,
    quizDrafts: [...quizDrafts],
    queuedDrafts: [...queuedDrafts],
    historyScope,
    quotaDismissals:[...quotaDismissals],
    reviewDismissals: [...reviewDismissals],
    state: {
      key: state.key,
      id: state.id,
      name: state.name,
      prefs: state.prefs,
    },
  });
}
function close() {
  menu?.remove();
  menu = null;
  menuKind = null;
  reasoningView = null;
  modeView = null;
  fastView = null;
  modelListRender = null;
  commandMenuRender = null;
  clientMenuRender = null;
  historyListRender = null;
  fileListView = null;
  mention = null;
  clearTimeout(fileTimer);
  sessionTabs.closeContext();
  search = "";
  slash.setAttribute("aria-expanded", "false");
}
function placeMenu() {
  if (menu) {
    menu.style.setProperty(
      "--menu-room",
      Math.max(100, composer.getBoundingClientRect().top - 12) + "px",
    );
    const trigger = ({access,attach,limits:limitsButton,execution:limitsButton})[menuKind];
    if (trigger) {
      menu.classList.add('anchored-menu');
      const bounds=composer.getBoundingClientRect(), width=menu.getBoundingClientRect().width;
      menu.style.left=(menuKind==='access' ? 0 : Math.max(0,Math.min(trigger.getBoundingClientRect().left-bounds.left,bounds.width-width)))+'px';
      menu.style.right='auto';
    }
  }
}
function resizeComposer() {
  const emptyChat = !state.items.length && !state.busy && !sending;
  composer.classList.toggle('is-new-chat', emptyChat);
  const parked = composerParked();
  input.classList.toggle('parked', parked);
  const signature =
    input.value + "\u0000" + input.clientWidth + "\u0000" + innerHeight + "\u0000" + emptyChat + "\u0000" + parked;
  if (inputSizeSignature === signature) return;
  inputSizeSignature = signature;
  input.style.height = "auto";
  const minimumHeight = parseFloat(getComputedStyle(input).minHeight);
  input.style.height = parked ? minimumHeight + "px" :
    Math.max(minimumHeight, Math.min(input.scrollHeight, 240, innerHeight * 0.35)) + "px";
  if (parked) { input.scrollTop = 0; if (document.activeElement === input) input.setSelectionRange(0, 0); }
  placeMenu();
}
function dialog(label, kind) {
  close();
  menuKind = kind;
  menu = el("section", undefined, "menu");
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", label);
  const bar = el("div", undefined, "menu-header");
  bar.append(el("strong", label));
  if (!["model", "account"].includes(kind)) {
    const x = el("button", undefined, "icon-button");
    x.append(icon("close"));
    x.setAttribute("aria-label", WorkbenchI18n.t("Закрыть"));
    x.onclick = () => {
      close();
      input.focus();
    };
    bar.append(x);
  }
  menu.append(bar);
  composer.append(menu);
  if (['access','attach','limits','execution'].includes(kind)) menu.classList.add('anchored-menu');
  placeMenu();
  slash.setAttribute("aria-expanded", "true");
  return menu;
}
function row(
  parent,
  label,
  description,
  action,
  { disabled = false, checked, toggle = false, danger = false, iconName, existing } = {},
) {
  const b = existing || el("button", undefined, "menu-row");
  b.type = "button";
  b.disabled = disabled;
  b.title = [label, description].filter(Boolean).join(" — ");
  b.classList.toggle("danger-action", danger);
  if (iconName && !existing) b.append(icon(iconName));
  let text = b.querySelector('.menu-row-text');
  if (!text) {
    text = el("span", undefined, "menu-row-text");
    text.append(el("strong"), el("small"));
    b.append(text);
  }
  if (text.firstElementChild.textContent !== label) text.firstElementChild.textContent = label;
  if (text.lastElementChild.textContent !== (description || "")) text.lastElementChild.textContent = description || "";
  if (checked !== undefined) {
    let mark = b.querySelector(toggle ? '.switch' : '.check');
    if (!mark) {
      mark = el("span", undefined, toggle ? "switch" : "check");
      if (toggle) mark.append(el("span", undefined, "switch-thumb"));
      b.append(mark);
    }
    mark.setAttribute("aria-hidden", "true");
    if (toggle) {
      b.setAttribute("role", "switch");
      b.setAttribute("aria-checked", String(checked));
      mark.classList.toggle("on", checked);
    } else {
      b.setAttribute("aria-pressed", String(checked));
      const check = checked ? "✓" : "";
      if (mark.textContent !== check) mark.textContent = check;
    }
  }
  b.onclick = () => action?.();
  if (toggle && checked !== undefined)
    toggles.bind(b, { key: label, checked: !!checked, disabled, action });
  if (b.parentElement !== parent) parent.append(b);
  return b;
}
function currentModel() {
  return state.models.find((m) => m.model === state.model);
}
function messageContent(item) {
  return new WorkbenchMarkdownView({ icon, send }).render(item);
}
function settings(effort, toggleRequestId) {
  pendingEffort = { key: state.key, model: state.model, effort };
  send("settings", { effort, ...(toggleRequestId ? { toggleRequestId } : {}) });
}
function searchProjectFiles(query, immediate = false) {
  clearTimeout(fileTimer);
  const generation = ++filesGeneration;
  fileListView?.render(query, true);
  fileTimer = setTimeout(
    () => send("projectFiles", { query, generation }),
    immediate ? 0 : 120,
  );
}
function chooseProjectFile(file) {
  if (
    mention &&
    input.value.slice(mention.start, mention.end) === "@" + mention.query
  )
    input.value =
      input.value.slice(0, mention.start) + input.value.slice(mention.end);
  persist();
  send("draft", { text: input.value });
  send("attachProjectFile", { id: file.id });
  close();
  input.focus();
}
function reasoningControl(target) {
  const container = el("section", undefined, "reasoning-control"),
    heading = el("div", undefined, "reasoning-heading"),
    label = el("label", WorkbenchI18n.t("Размышление")),
    value = el("output"),
    slider = el("div", undefined, "reasoning-slider"),
    thumb = el("span", undefined, "reasoning-thumb"),
    range = el("input"),
    ticks = el("div", undefined, "reasoning-ticks");
  range.type = "range";
  range.min = 0;
  range.step = 1;
  range.setAttribute("aria-label", WorkbenchI18n.t("Глубина размышления"));
  range.id = "reasoning-range";
  label.htmlFor = range.id;
  heading.append(label, value);
  thumb.setAttribute("aria-hidden", "true");
  slider.append(ticks, thumb, range);
  container.append(heading, slider);
  target.append(container);
  let options = [],
    dragging = false;
  const show = () => {
    const selected = options[Number(range.value)],
      effort = selected?.reasoningEffort,
      name = WorkbenchControls.label(effort) || WorkbenchI18n.t("Недоступно");
    value.textContent = "(" + name + ")";
    range.setAttribute("aria-valuetext", name);
    range.title = selected?.description || name;
    slider.style.setProperty("--reasoning-offset",
      (options.length > 1 ? 60 * Number(range.value) / (options.length - 1) : 30) + "px");
    for (const [i, node] of [...ticks.children].entries())
      node.classList.toggle("selected", i === Number(range.value));
  };
  range.onpointerdown = () => (dragging = true);
  range.onpointerup = () => (dragging = false);
  range.onpointercancel = () => {
    dragging = false;
    pendingEffort = null;
    reasoningView?.update();
  };
  range.oninput = () => {
    const effort = options[Number(range.value)]?.reasoningEffort;
    if (effort) pendingEffort = { key: state.key, model: state.model, effort };
    show();
  };
  range.onchange = () => {
    dragging = false;
    const effort = options[Number(range.value)]?.reasoningEffort;
    if (effort) settings(effort);
  };
  reasoningView = {
    update() {
      if (dragging) return;
      const model = currentModel();
      options = WorkbenchControls.levels(model);
      range.max = Math.max(0, options.length - 1);
      range.disabled = !!pendingModel || options.length < 2;
      slider.classList.toggle("disabled", range.disabled);
      range.value = Math.max(
        0,
        options.findIndex(
          (option) =>
            option.reasoningEffort ===
            (pendingEffort?.key === state.key &&
            pendingEffort.model === state.model
              ? pendingEffort.effort
              : state.effort),
        ),
      );
      ticks.replaceChildren();
      for (const [index, option] of options.entries()) {
        const tick = el("span");
        tick.style.left =
          (options.length > 1 ? 8 + (60 * index) / (options.length - 1) : 38) +
          "px";
        tick.title = WorkbenchControls.label(option.reasoningEffort);
        ticks.append(tick);
      }
      show();
    },
  };
  reasoningView.update();
  return container;
}
function effortControls(target) {
  const fast=row(target,'Fast',WorkbenchI18n.t('Ускоренные ответы; повышенный расход лимитов'),
    toggleRequestId=>send('fast',{enabled:!state.prefs.fast,toggleRequestId}),{checked:!!state.prefs.fast,toggle:true});
  fast.classList.add('mode-row','fast-row');fast.prepend(icon('bolt'));
  fastView={update(){
    const supported=!!WorkbenchSpeed.fastTier(currentModel());
    const disabled=!!state.busy || !!state.compacting || !!pendingModel || !supported;
    fast.title=WorkbenchI18n.t(supported?'Ускоренные ответы; повышенный расход лимитов':'Fast недоступен для этой модели или аккаунта.');
    const enabled=supported && !!state.prefs.fast;
    toggles.update(fast, { checked: enabled, disabled });
  }};
  fastView.update();
  const depth = reasoningControl(target);
  depth.prepend(icon("effort"));
}
function renderContext() {
  contextButton.classList.toggle('ring-only', state.contextDisplay === 'ring');
  const meter = WorkbenchControls.context(state),
    percent = meter?.percent || 0;
  circles[1].setAttribute("stroke-dasharray", `${percent} 100`);
  contextButton.classList.toggle("unknown", !meter);
  contextButton.classList.toggle('context-full',!!meter && Math.round(percent)===100);
  contextButton.classList.toggle("compacting", !!state.compacting);
  contextButton.classList.toggle(
    "warning-action",
    !!meter && percent >= 75 && percent < 90,
  );
  contextButton.classList.toggle("danger-action", !!meter && percent >= 90);
  contextButton.disabled = !state.id || !!state.busy;
  contextValue.textContent = state.compacting
    ? "…"
    : meter
      ? Math.round(percent)+'%'
      : "?";
  contextButton.title = state.compacting
    ? WorkbenchI18n.t("Сжатие контекста…")
    : meter
      ? WorkbenchI18n.t(
          "Контекст: {0}% · {1} из {2} токенов. Нажмите, чтобы сжать.",
          Math.round(percent),
          meter.used.toLocaleString(WorkbenchI18n.language),
          meter.window.toLocaleString(WorkbenchI18n.language),
        )
      : state.usageStale
        ? WorkbenchI18n.t(
            "Контекст изменился. Объём обновится после следующего замера. Нажмите, чтобы сжать.",
          )
        : WorkbenchI18n.t(
            "Объём контекста пока неизвестен. Нажмите, чтобы сжать сохранённую сессию.",
          );
  contextButton.setAttribute("aria-label", contextButton.title);
}
function open(kind, refresh = true, changeItems = null) {
  if (menuKind === kind) {
    close();
    return;
  }
  if (kind === "limits") {
    renderLimits();
    send("limits");
    return;
  }
  if (kind === "bookmarks") {
    selectedBookmark = null;
    bookmarksQuery = "";
    renderBookmarks();
    return;
  }
  if (kind === "skills") {
    skills = [];
    skillsQuery = "";
    skillsLoading = true;
    skillsErrors = 0;
    renderSkills();
    send("skills", { generation: ++skillsGeneration });
    return;
  }
  if (kind === "language") {
    const target = dialog(WorkbenchI18n.t("Язык интерфейса"), "language");
    for (const [value, label] of [
      ["auto", WorkbenchI18n.t("Автоматически — как в VS Code")],
      ["en", "English"],
      ["ru", "Русский"],
    ])
      row(
        target,
        label,
        "",
        () => {
          send("language", { language: value, currentDraft: input.value });
          close();
        },
        { checked: (state.languageChoice || "auto") === value },
      );
    return;
  }
  if (kind === "attach") {
    const target = dialog(WorkbenchI18n.t("Добавить в контекст"), "attach");
    row(
      target,
      WorkbenchI18n.t("Файл проекта"),
      WorkbenchI18n.t("Поиск файлов через @"),
      () => open("files"),
    );
    row(
      target,
      WorkbenchI18n.t("Файл с компьютера"),
      WorkbenchI18n.t("Документы и изображения"),
      () => {
        send("attach");
        close();
      },
    );
    row(
      target,
      WorkbenchI18n.t("Выделенный код"),
      WorkbenchI18n.t("Снимок выделения из редактора"),
      () => {
        send("selection");
        close();
      },
    );
    row(
      target,
      WorkbenchI18n.t("Навыки Codex"),
      WorkbenchI18n.t("Доступные навыки из официального CLI"),
      () => open("skills"),
    );
    row(
      target,
      WorkbenchI18n.t("Команды Codex"),
      WorkbenchI18n.t("Команды и настройки этой сессии"),
      () => open("commands"),
    );
    return;
  }
  if (kind === "files") {
    const activeMention = mention,
      target = dialog(WorkbenchI18n.t("Файлы проекта"), "files"),
      list = el("div"),
      status = el("small", undefined, "file-search-status");
    mention = activeMention;
    let query;
    if (!mention) {
      query = el("input");
      query.placeholder = WorkbenchI18n.t("Найти файл по пути…");
      query.setAttribute("aria-label", WorkbenchI18n.t("Поиск файла проекта"));
      query.oninput = () => searchProjectFiles(query.value);
      query.onkeydown = (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          list.querySelector(".menu-row")?.click();
        }
      };
      target.append(query);
    } else
      target.append(
        el(
          "small",
          WorkbenchI18n.t(
            "Введите часть пути после @. Enter добавляет выбранный файл.",
          ),
        ),
      );
    target.append(list, status);
    fileListView = {
      query: mention?.query || "",
      render(value = this.query, loading = false, truncated = false) {
        this.query = value;
        list.replaceChildren();
        const visible = fileResults.filter((file) =>
          file.name
            .toLocaleLowerCase()
            .includes(value.replace(/\\/g, "/").toLocaleLowerCase()),
        );
        for (const file of visible)
          row(
            list,
            file.name,
            WorkbenchI18n.t("Добавить файл в контекст"),
            () => chooseProjectFile(file),
          );
        status.textContent = loading
          ? WorkbenchI18n.t("Поиск файлов…")
          : truncated
            ? WorkbenchI18n.t("Показаны первые совпадения. Уточните путь.")
            : visible.length
              ? ""
              : state.cwd
                ? WorkbenchI18n.t("Совпадений нет.")
                : WorkbenchI18n.t("Откройте папку проекта.");
      },
    };
    fileResults = [];
    searchProjectFiles(mention?.query || "", true);
    if (query) query.focus();
    return;
  }
  if (kind === "rename") {
    sessionTabs.startRename();
    return;
  }
  if (kind === "group") {
    const target = dialog(WorkbenchI18n.t("Группа сессии"), "group"),
      form = el("form"),
      name = el("input");
    name.value = state.group || "";
    name.maxLength = 100;
    name.placeholder = WorkbenchI18n.t(
      "Название группы или пусто, чтобы убрать",
    );
    name.setAttribute("aria-label", WorkbenchI18n.t("Название группы"));
    const save = el("button", WorkbenchI18n.t("Сохранить"), "primary");
    form.append(name, save);
    form.onsubmit = (e) => {
      e.preventDefault();
      send("group", { name: name.value });
      close();
    };
    target.append(form);
    name.focus();
    return;
  }
  if (kind === "history") {
    send("history", {
      scope: historyScope,
      query: historyQuery,
      generation: ++historyGeneration,
    });
    renderHistory();
    return;
  }
  if (kind === "defaults") {
    const target = dialog(
        WorkbenchI18n.t("Настройки новых сессий"),
        "defaults",
      ),
      form = el("form"),
      models = el("select"),
      depth = el("select");
    models.setAttribute(
      "aria-label",
      WorkbenchI18n.t("Модель для новых сессий"),
    );
    depth.setAttribute(
      "aria-label",
      WorkbenchI18n.t("Глубина для новых сессий"),
    );
    for (const m of state.models) {
      const option = el("option", m.displayName || m.model);
      option.value = m.model;
      option.selected = m.model === (state.defaults?.model || state.model);
      models.append(option);
    }
    const levels = () => {
      depth.replaceChildren();
      for (const value of state.models.find((m) => m.model === models.value)
        ?.supportedReasoningEfforts || []) {
        const option = el("option", value.reasoningEffort);
        option.value = value.reasoningEffort;
        option.selected =
          value.reasoningEffort === (state.defaults?.effort || state.effort);
        depth.append(option);
      }
    };
    models.onchange = levels;
    levels();
    form.append(
      el("label", WorkbenchI18n.t("Модель")),
      models,
      el("label", WorkbenchI18n.t("Глубина")),
      depth,
      el("button", WorkbenchI18n.t("Сохранить"), "primary"),
    );
    form.onsubmit = (e) => {
      e.preventDefault();
      send("defaults", { model: models.value, effort: depth.value });
      close();
    };
    target.append(
      form,
      el(
        "small",
        WorkbenchI18n.t(
          "Применяется только к новым вкладкам этого проекта. Текущая сессия не меняется.",
        ),
      ),
    );
    return;
  }
  if (kind === "model") {
    if(refresh)send('models');
    const target = dialog(WorkbenchI18n.t("Модель и размышление"), "model");
    target.classList.add("model-menu");
    if(state.busy)target.append(el('small',WorkbenchI18n.t('Выбор применяется к следующему запросу. Текущая задача продолжит работу на прежней модели.')));
    const query = el("input");
    query.placeholder = WorkbenchI18n.t("Найти модель…");
    query.setAttribute("aria-label", WorkbenchI18n.t("Поиск модели"));
    query.className = "model-search";
    const list = el("div", undefined, "model-list"),
      extras = el("div", undefined, "model-extras");
    target.append(query, list, extras);
    effortControls(extras);
    const render = () => {
      const visible = state.models.filter((m) =>
        (m.displayName + " " + m.model)
          .toLowerCase()
          .includes(query.value.toLowerCase()),
      ).map(m => [m.model, m]);
      WorkbenchControls.keyedRows(list, visible, ([id, m], existing) =>
        row(
          list,
          m.displayName || m.model,
          m.description,
          () => {
            if (m.model === state.model) return;
            pendingModel = m.model;
            updateSubmitState();
            send("settings", { model: m.model });
            reasoningView?.update();
          },
          {
            checked: m.model === state.model,
            disabled: !!pendingModel,
            existing,
          },
        ));
    };
    modelListRender = render;
    query.oninput = render;
    render();
    query.focus();
    return;
  }
  if (kind === "depth") {
    const target = dialog(WorkbenchI18n.t("Глубина размышления"), "depth");
    reasoningControl(target);
    return;
  }
  if (kind === "access") {
    const target = dialog(WorkbenchI18n.t("Режимы"), "access");
    target.classList.add("mode-menu");
    const buttons = [],
      list = el("div", undefined, "mode-list");
    target.append(list);
    const additional=el('details',undefined,'mode-additional');
    additional.append(el('summary',WorkbenchI18n.t('Дополнительные режимы')));
    additional.open=['manual','plan'].includes(state.prefs.pendingMode || WorkbenchModes.current(state.prefs).id);
    for (const id of ['workspace','auto','full','manual','plan']) {
      const mode=WorkbenchModes.modes.find(mode=>mode.id===id);
      const b = row(
        ['manual','plan'].includes(id)?additional:list,
        WorkbenchI18n.t(mode.label),
        WorkbenchI18n.t(mode.description),
        () => {
          send("mode", { mode: mode.id });
          close();
        },
        {
          checked: (state.prefs.pendingMode || WorkbenchModes.current(state.prefs).id) === mode.id,
          disabled: false,
          danger: mode.id === "full",
        },
      );
      b.classList.add("mode-row");
      b.dataset.mode = mode.id;
      b.prepend(icon(mode.icon));
      buttons.push([mode, b]);
    }
    list.append(additional);
    const pendingHint=el('p',WorkbenchI18n.t('Изменение режима применится после завершения текущего ответа.'),'mode-pending-hint');
    target.append(pendingHint);
    const extras = el("div", undefined, "mode-extras");
    target.append(extras);
    effortControls(extras);
    modeView = {
      update() {
        const active = state.prefs.pendingMode || WorkbenchModes.current(state.prefs).id;
        pendingHint.hidden=!state.busy && !state.prefs.pendingMode;
        for (const [mode, b] of buttons) {
          b.disabled = false;
          b.setAttribute("aria-pressed", String(mode.id === active));
          b.classList.toggle("selected", mode.id === active);
          b.querySelector(".check").textContent = mode.id === active ? "✓" : "";
        }
      },
    };
    modeView.update();
    return;
  }
  if (kind === "changes") {
    const target = dialog(WorkbenchI18n.t("Изменённые файлы"), "changes");
    let count = 0;
    for (const item of changeItems || state.items)
      for (const [index, change] of (item.changes || []).entries()) {
        count++;
        target.append(
          WorkbenchChanges.card(change, {
            cwd: state.cwd,
            icon,
            open: () => {
              send("diff", { itemId: item.id, index });
              close();
            },
          }),
        );
      }
    if (!count)
      target.append(
        el("p", WorkbenchI18n.t("В этой сессии пока нет изменённых файлов.")),
      );
    return;
  }
  if (kind === "context") {
    const target = dialog(WorkbenchI18n.t("Контекст сессии"), "context");
    for (const [label, value] of [
      [
        WorkbenchI18n.t("Сессия"),
        state.id || WorkbenchI18n.t("Локальный черновик"),
      ],
      [WorkbenchI18n.t("Проект"), state.cwd || WorkbenchI18n.t("Не выбран")],
      [
        WorkbenchI18n.t("Родительская ветка"),
        state.parentId || WorkbenchI18n.t("Основная сессия"),
      ],
      [
        WorkbenchI18n.t("Хранение"),
        WorkbenchI18n.t(
          "Переписка — в профиле Codex CLI. Черновики и настройки — локально, доступны другим окнам VS Code.",
        ),
      ],
    ]) {
      target.append(el("strong", label), el("p", value));
    }
    return;
  }
  if (kind === 'client') {
    const target=dialog(WorkbenchI18n.t('Клиент и обновления'),'client');
    const version = el('strong'), status = el('p');
    target.append(version);
    let automatic, stable, alpha, check;
    const phases={checking:'Проверяем обновления…',downloading:'Загружаем обновление…',
      applying:'Применяем обновление…',pending:'Обновление готово; ждём завершения задач',
      error:'Обновить не удалось; сохранён предыдущий клиент',ready:'Клиент актуален'};
    clientMenuRender = () => {
      cliMenuSignature = JSON.stringify(state.cli);
      const info = state.cli || {}, channel = info.channel || 'stable';
      const title = 'Codex CLI · ' + (info.version || WorkbenchI18n.t('Версия пока неизвестна'));
      if (version.textContent !== title) version.textContent = title;
      automatic = row(target,WorkbenchI18n.t('Обновлять автоматически'),
        WorkbenchI18n.t('Проверять каждый час; применять между задачами'),
        toggleRequestId=>send('cliSettings',{autoUpdate:info.autoUpdate===false,toggleRequestId}),
        {checked:info.autoUpdate!==false,disabled:info.custom,toggle:true,existing:automatic});
      stable = row(target,WorkbenchI18n.t('Релизная'),WorkbenchI18n.t('Стабильный канал latest'),
        ()=>send('cliSettings',{channel:'stable'}),{checked:channel==='stable',disabled:info.custom,existing:stable});
      alpha = row(target,WorkbenchI18n.t('Ночная / Alpha'),WorkbenchI18n.t('Предварительные сборки официального CLI'),
        ()=>send('cliSettings',{channel:'alpha'}),{checked:channel==='alpha',disabled:info.custom,existing:alpha});
      const message = info.custom ? WorkbenchI18n.t('Используется свой CLI: автоматическая замена отключена.') :
        (phases[info.phase] ? WorkbenchI18n.t(phases[info.phase]) : '');
      if (status.textContent !== message) status.textContent = message;
      status.style.display = message ? '' : 'none';
      if (status.parentElement !== target) target.append(status);
      check = row(target,WorkbenchI18n.t('Проверить обновления сейчас'),
        WorkbenchI18n.t('Также обновить список моделей из клиента'),()=>send('cliCheck'),
        {disabled:info.custom || ['checking','downloading','applying'].includes(info.phase),existing:check});
    };
    clientMenuRender();
    return;
  }
  if (kind === 'account') {
    accountMenuSignature = accountSignature();
    if (refresh) send('accountRefresh');
    const target = dialog(WorkbenchI18n.t('Аккаунт Codex'), 'account');
    target.classList.add('account-menu');
    target.append(el('small', 'Rundix · ' + (document.documentElement.dataset.uiVersion || 'development'), 'ui-version'));
    const card = el('div', undefined, 'account-identity');
    card.append(icon('rundix'));
    const details = el('div', undefined, 'account-identity-details');
    details.append(el('small', WorkbenchI18n.t('Активный аккаунт')),
      el('strong', state.connection?.external ? state.connection.label : state.loginPending ? WorkbenchI18n.t('Ожидаем вход в браузере') : state.account?.email || state.account?.type || WorkbenchI18n.t('Вход не выполнен'), 'account-email'));
    if (state.account) new WorkbenchAccountUsageView({el}).render(details, state.limits, {loading: state.limits?.loading});
    card.append(details);
    target.append(card, el('p', WorkbenchI18n.t(state.connection?.external ? 'Авторизация управляется расширением подключения.' : 'Используется текущий вход официального Codex CLI на этом компьютере.')));
    if (state.connection?.configurable) row(target, WorkbenchI18n.t('Настройки подключения'), state.connection.label, () => send('connectionSettings'), {disabled:state.busy || state.authBusy});
    const connectionMenu=state.connection?.menu;
    if (connectionMenu?.loading) target.append(el('p',WorkbenchI18n.t('Загрузка…')));
    if (connectionMenu?.error) target.append(el('p',WorkbenchI18n.t('Не удалось обновить меню подключения. Нажмите «Обновить статус».')));
    if (connectionMenu?.items?.length) {
      target.append(el('small',connectionMenu.title));
      for (const item of connectionMenu.items) row(target,item.label,item.detail,
        ()=>send('connectionMenuAction',{id:item.id,revision:connectionMenu.revision}),
        {checked:item.checked,disabled:item.disabled || state.busy || state.authBusy || state.compacting});
    }
    if (!state.connection?.external && state.loginPending) {
      target.append(el('p', WorkbenchI18n.t('Завершите вход в открытом браузере.')));
      row(target, WorkbenchI18n.t('Отменить вход'), '', () => send('accountCancel'));
    } else if (!state.connection?.external && !state.account) {
      row(target, WorkbenchI18n.t('Войти через браузер'), WorkbenchI18n.t('Официальная авторизация Codex'), () => send('account'), {disabled: state.busy || state.authBusy});
    }
    row(target, WorkbenchI18n.t('Обновить статус'), WorkbenchI18n.t('Проверить аккаунт и доступные модели'), () => send('accountRefresh'));
    row(target, WorkbenchI18n.t('Клиент и обновления'), 'Codex CLI · ' + (state.cli?.version || ''), () => open('client'));
    return;
  }
  const target = dialog(WorkbenchI18n.t("Команды"), "commands");
  commandMenuSignature = commandsSignature();
  target.classList.add("command-menu");
  const query = el("input");
  query.placeholder = WorkbenchI18n.t("Поиск функций и команд…");
  query.setAttribute("aria-label", WorkbenchI18n.t("Поиск команды"));
  query.className = "command-search";
  query.type = "search";
  const list = el("div", undefined, "command-list");
  target.append(query, list);
  const commands = () => {
  const m = currentModel(),
    supportsOff = m?.supportedReasoningEfforts.some(
      (o) => o.reasoningEffort === "none",
    );
  return [
    ['mcp','MCP · Claude Code',WorkbenchI18n.t('Подключение, задачи и управление мостом MCP'),()=>{close();send('mcpPanel');}],
    ['prepare',WorkbenchI18n.t('Подготовить задачу · эксперимент'),WorkbenchI18n.t('Включайте подготовку перед первым сообщением нового чата.'),
      toggleRequestId=>send('preflight',{enabled:!state.preflight?.enabled,toggleRequestId}),
      {disabled:!!state.id||!!state.busy,checked:!!state.preflight?.enabled,toggle:true}],
    ['fast','Fast',WorkbenchI18n.t('Ускоренные ответы; повышенный расход лимитов'),
      toggleRequestId=>send('fast',{enabled:!state.prefs.fast,toggleRequestId}),
      {disabled:!!state.busy || !!state.compacting || !WorkbenchSpeed.fastTier(m),checked:!!state.prefs.fast && !!WorkbenchSpeed.fastTier(m),toggle:true}],
    ['client',WorkbenchI18n.t('Клиент и обновления'),WorkbenchI18n.t('Версия CLI, канал и автоматическое обновление'),()=>open('client')],
    [
      "limits",
      WorkbenchI18n.t("Лимиты Codex"),
      WorkbenchI18n.t("Остаток и время сброса"),
      () => open("limits"),
    ],
    [
      "bookmarks",
      WorkbenchI18n.t("Закладки ответов"),
      WorkbenchI18n.t("Сохранённые ответы этой сессии"),
      () => open("bookmarks"),
    ],
    [
      "skills",
      WorkbenchI18n.t("Навыки Codex"),
      WorkbenchI18n.t("Доступные навыки из официального CLI"),
      () => open("skills"),
    ],
    [
      "language",
      WorkbenchI18n.t("Язык интерфейса"),
      WorkbenchI18n.t("Выбрать язык интерфейса"),
      () => open("language"),
    ],
    ["model", WorkbenchI18n.t("Модель"), state.model, () => open("model")],
    [
      "thinking",
      WorkbenchI18n.t("Размышление"),
      supportsOff
        ? WorkbenchI18n.t("Включить или выключить")
        : WorkbenchI18n.t("Off недоступен для этой модели"),
      toggleRequestId => {
        const on = [
          state.prefs.previousEfforts?.[state.model],
          m.defaultReasoningEffort,
          ...m.supportedReasoningEfforts.map((o) => o.reasoningEffort),
        ].find(
          (e) =>
            e &&
            e !== "none" &&
            m.supportedReasoningEfforts.some((o) => o.reasoningEffort === e),
        );
        settings(state.effort === "none" ? on : "none", toggleRequestId);
      },
      {
        disabled: state.busy || !supportsOff,
        checked: state.effort !== "none",
        toggle: true,
      },
    ],
    [
      "depth",
      WorkbenchI18n.t("Глубина размышления"),
      state.effort,
      () => open("depth"),
    ],
    [
      "focus",
      WorkbenchI18n.t("Режим фокуса"),
      WorkbenchI18n.t('Свернуть служебные шаги в статус со счётчиком'),
      toggleRequestId => send("preferences", { focus: !state.prefs.focus, toggleRequestId }),
      { checked: state.prefs.focus, toggle: true },
    ],
    [
      'chat-width',
      WorkbenchI18n.t('Широкий чат'),
      WorkbenchI18n.t('Широкая лента сообщений и результатов'),
      toggleRequestId=>send('chatWidth',{value:state.chatWidth==='compact'?'wide':'compact',toggleRequestId}),
      {checked:state.chatWidth!=='compact',toggle:true},
    ],
    [
      'context-display',
      WorkbenchI18n.t('Проценты в кольце контекста'),
      WorkbenchI18n.t('Выключите для маленького кольца без цифр'),
      toggleRequestId=>send('contextDisplay',{value:state.contextDisplay==='ring'?'percent':'ring',toggleRequestId}),
      {checked:state.contextDisplay!=='ring',toggle:true},
    ],
    [
      "show-thinking",
      WorkbenchI18n.t("Показывать размышления"),
      WorkbenchI18n.t("Отображение кратких рассуждений в чате"),
      toggleRequestId => send("preferences", { showThinking: !state.prefs.showThinking, toggleRequestId }),
      { checked: state.prefs.showThinking, toggle: true },
    ],
    [
      "ide",
      WorkbenchI18n.t("Контекст IDE"),
      WorkbenchI18n.t("Передавать путь активного файла и выделение"),
      toggleRequestId => send("preferences", { ide: !state.prefs.ide, toggleRequestId }),
      { checked: state.prefs.ide, toggle: true },
    ],
    [
      "plan",
      WorkbenchI18n.t("Планирование"),
      WorkbenchI18n.t("Обсудить план перед выполнением"),
      toggleRequestId => send("preferences", { plan: !state.prefs.plan, toggleRequestId }),
      { checked: !!state.prefs.plan, toggle: true },
    ],
    [
      "compact",
      WorkbenchI18n.t("Сжать контекст"),
      WorkbenchI18n.t("Официальное сжатие истории текущей сессии"),
      () => {
        send("compact");
        close();
      },
      { disabled: !state.id || state.busy },
    ],
    [
      "history",
      WorkbenchI18n.t("История"),
      WorkbenchI18n.t("Открытые и недавние сессии"),
      () => open("history"),
    ],
    [
      "new",
      WorkbenchI18n.t("Новая вкладка"),
      WorkbenchI18n.t("Независимая сессия Rundix"),
      () => {
        send("new");
        close();
      },
    ],
    [
      "rename",
      WorkbenchI18n.t("Переименовать"),
      WorkbenchI18n.t("Задать название этой вкладки"),
      () => open("rename"),
    ],
    [
      "access",
      WorkbenchI18n.t("Доступ"),
      WorkbenchI18n.t("Режим работы с файлами и командами"),
      () => open("access"),
    ],
    [
      "reopen",
      WorkbenchI18n.t("Восстановить вкладку"),
      WorkbenchI18n.t("Последняя закрытая сессия, включая пустую"),
      () => {
        send("reopen");
        close();
      },
    ],
    [
      "beside",
      WorkbenchI18n.t("Новая сессия сбоку"),
      WorkbenchI18n.t("Открыть вкладку в соседней группе редактора"),
      () => {
        send("beside");
        close();
      },
    ],
    [
      "last",
      WorkbenchI18n.t("Последняя сессия"),
      WorkbenchI18n.t("Вернуться к последней вкладке"),
      () => {
        send("openLast");
        close();
      },
    ],
    [
      "window",
      WorkbenchI18n.t("Новое окно"),
      WorkbenchI18n.t("Новая сессия в отдельном окне VS Code"),
      () => {
        send("newWindow");
        close();
      },
    ],
    [
      "group",
      WorkbenchI18n.t("Группа сессии"),
      state.group || WorkbenchI18n.t("Объединить сессии по теме"),
      () => open("group"),
    ],
    [
      "unread",
      WorkbenchI18n.t("Пометить непрочитанной"),
      WorkbenchI18n.t("Поставить метку на этой сессии"),
      () => {
        send("unread");
        close();
      },
    ],
    [
      "selection",
      WorkbenchI18n.t("Добавить выделенный код"),
      WorkbenchI18n.t("Снимок выделения из редактора"),
      () => {
        send("selection");
        close();
      },
    ],
    [
      "defaults",
      WorkbenchI18n.t("Настройки новых сессий"),
      WorkbenchI18n.t("Модель и глубина для следующих вкладок"),
      () => open("defaults"),
    ],
    [
      "files",
      WorkbenchI18n.t("Файл проекта (@)"),
      WorkbenchI18n.t("Найти и добавить файл из текущего проекта"),
      () => open("files"),
    ],
    [
      "changes",
      WorkbenchI18n.t("Изменения файлов"),
      WorkbenchI18n.t("Сравнение до / после в редакторе VS Code"),
      () => open("changes"),
    ],
    [
      "context",
      WorkbenchI18n.t("Контекст сессии"),
      WorkbenchI18n.t("Проект, локальная история и родительская ветка"),
      () => open("context"),
    ],
    [
      "fork",
      WorkbenchI18n.t("Создать ветку"),
      WorkbenchI18n.t(
        "Новая сессия с копией текущего контекста в этом проекте",
      ),
      () => {
        send("fork");
        close();
      },
      { disabled: !state.id || state.busy },
    ],
    [
      "continue-window",
      WorkbenchI18n.t("Продолжить в новом окне"),
      WorkbenchI18n.t("Та же сессия, контекст и черновик"),
      () => {
        send("continueWindow");
        close();
      },
    ],
    [
      "help",
      WorkbenchI18n.t("Расположение инструментов"),
      WorkbenchI18n.t("Показать назначение кнопок и команд"),
      () => {
        const target = dialog(WorkbenchI18n.t("Инструменты"), "help");
        target.append(
          el(
            "p",
            WorkbenchI18n.t(
              "Сессии открываются отдельными вкладками VS Code. Кнопка новой сессии находится справа рядом с историей и закладками. + — файлы и навыки, / — команды. Переименовать: контекстное меню вкладки или /rename. Enter и клик вне поля сохраняют имя, Escape отменяет.",
            ),
          ),
        );
      },
    ],
    [
      "account",
      WorkbenchI18n.t("Аккаунт"),
      state.account
        ? WorkbenchI18n.t("Подключён ") +
          (state.account.email || state.account.type || "Codex")
        : WorkbenchI18n.t("Войти через Codex CLI"),
      () => open("account"),
    ],
  ];
  };
  const normalize = (value) =>
    String(value || "")
      .toLocaleLowerCase()
      .replace(/ё/g, "е");
  const render = () => {
    const terms = normalize(query.value)
      .trim()
      .replace(/^\//, "")
      .split(/\s+/)
      .filter(Boolean);
    const visible = commands().filter(
      (c) =>
        terms.every((term) =>
          normalize(c.slice(0, 3).join(" ")).includes(term),
        ),
    );
    WorkbenchControls.keyedRows(list, visible, ([id, label, description, action, options], existing) =>
      row(list, label, description, action, {
        ...options,
        existing,
        iconName:
          {
            limits: "limits",
            bookmarks: "bookmark",
            model: "assistant",
            thinking: "effort",
            effort: "effort",
            focus: "controls",
            showThinking: "effort",
            ide: "code",
            plan: "plan",
            compact: "history",
            history: "history",
            new: "newchat",
            rename: "file",
            access: "controls",
            reopen: "history",
            changes: "file",
            account: "assistant",
            skills: "bolt",
            language: "controls",
          }[id] || "controls",
      }));
    if (!list.children.length)
      list.append(
        el(
          "p",
          WorkbenchI18n.t(
            "Ничего не найдено. Попробуйте другое название или описание.",
          ),
          "command-empty",
        ),
      );
  };
  query.oninput = render;
  commandMenuRender = render;
  query.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      list.querySelector(".menu-row:not(:disabled)")?.click();
    }
  };
  render();
  query.focus();
}
function renderSkills() {
  const target = dialog(WorkbenchI18n.t("Навыки Codex"), "skills");
  target.classList.add("command-menu");
  const query = el("input");
  query.className = "command-search";
  query.value = skillsQuery;
  query.placeholder = WorkbenchI18n.t("Найти навык…");
  query.setAttribute("aria-label", query.placeholder);
  const list = el("div", undefined, "command-list");
  target.append(query, list);
  const render = () => {
    list.replaceChildren();
    for (const skill of skills.filter((skill) =>
      (skill.name + " " + skill.description)
        .toLocaleLowerCase()
        .includes(query.value.toLocaleLowerCase()),
    ))
      row(list, skill.name, skill.description, () => {
        send("attachSkill", { id: skill.id });
        close();
        input.focus();
      });
    if (!list.children.length)
      list.append(
        el(
          "p",
          WorkbenchI18n.t(
            skillsLoading ? "Загрузка навыков…" : "Навыки не найдены.",
          ),
        ),
      );
    if (skillsErrors)
      list.append(
        el(
          "p",
          WorkbenchI18n.t(
            "Некоторые навыки не загрузились. Проверьте их файлы.",
          ),
        ),
      );
  };
  query.oninput = () => {
    skillsQuery = query.value;
    render();
  };
  query.onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      list.querySelector(".menu-row")?.click();
    }
  };
  render();
  query.focus();
}
function renderLimits() {
  limitsMenuSignature = JSON.stringify([state.limits, state.account]);
  const target = dialog(
    WorkbenchI18n.t("Лимиты"),
    "limits",
  );
  new WorkbenchLimitsView({ el, send }).render(target, state);
}
function renderBookmarks() {
  bookmarksSignature = JSON.stringify(state.bookmarks || []);
  const target = dialog(WorkbenchI18n.t("Закладки ответов"), "bookmarks");
  if (
    selectedBookmark &&
    !(state.bookmarks || []).some((item) => item.id === selectedBookmark.id)
  )
    selectedBookmark = null;
  if (selectedBookmark) {
    const bookmark = selectedBookmark;
    target.append(el("pre", bookmark.text, "bookmark-preview"));
    const actions = el("div", undefined, "bookmark-actions");
    button(
      WorkbenchI18n.t("Назад"),
      WorkbenchI18n.t("Назад"),
      () => {
        selectedBookmark = null;
        renderBookmarks();
      },
      actions,
    );
    button(
      WorkbenchI18n.t("Копировать сообщение"),
      WorkbenchI18n.t("Копировать сообщение"),
      () => send("copyBookmark", { itemId: bookmark.id }),
      actions,
    );
    button(
      WorkbenchI18n.t("Перейти к ответу"),
      WorkbenchI18n.t("Перейти к ответу"),
      () => {
        send("revealBookmark", { itemId: bookmark.id });
        close();
      },
      actions,
    );
    button(
      WorkbenchI18n.t("Удалить закладку"),
      WorkbenchI18n.t("Удалить закладку"),
      () => send("bookmark", { itemId: bookmark.id, enabled: false }),
      actions,
    );
    target.append(actions);
    return;
  }
  const query = el("input");
  query.value = bookmarksQuery;
  query.placeholder = WorkbenchI18n.t("Найти закладку…");
  query.setAttribute("aria-label", query.placeholder);
  const list = el("div");
  target.append(query, list);
  const render = () => {
    list.replaceChildren();
    for (const bookmark of (state.bookmarks || []).filter((item) =>
      item.title.toLocaleLowerCase().includes(query.value.toLocaleLowerCase()),
    ))
      row(
        list,
        bookmark.title,
        new Date(bookmark.createdAt).toLocaleString(WorkbenchI18n.language),
        () => send("bookmarkRead", { itemId: bookmark.id }),
      );
    if (!list.children.length)
      list.append(
        el(
          "p",
          WorkbenchI18n.t(
            "Закладок нет. Сохраните ответ значком закладки под ним.",
          ),
        ),
      );
  };
  query.oninput = () => {
    bookmarksQuery = query.value;
    render();
  };
  render();
  query.focus();
}
function revealItem(id) {
  const node = [...messages.querySelectorAll("[data-item-id]")].find(
    (node) => node.dataset.itemId === id,
  );
  if (!node) return false;
  node.scrollIntoView({ block: "center" });
  transcriptScroll.restore(messages.scrollTop);
  node.classList.add("revealed");
  setTimeout(() => node.classList.remove("revealed"), 1800);
  return true;
}
function renderHistory() {
  if (menuKind === "history" && historyListRender) { historyListRender();return; }
  const target = dialog(WorkbenchI18n.t("История сессий"), "history"),
    query = el("input");
  query.value = historyQuery;
  query.placeholder = WorkbenchI18n.t("Найти сессию…");
  query.setAttribute("aria-label", WorkbenchI18n.t("Поиск сессии"));
  const scope = el("select");
  scope.setAttribute("aria-label", WorkbenchI18n.t("Область истории"));
  for (const [value, label] of [
    ["workspace", WorkbenchI18n.t("Этот проект")],
    ["all", WorkbenchI18n.t("Все проекты")],
  ]) {
    const option = el("option", label);
    option.value = value;
    option.selected = value === historyScope;
    scope.append(option);
  }
  const list = el("div");
  target.append(scope, query, list);
  const rows = new Map();
  const more = el("button", WorkbenchI18n.t("Загрузить ещё"));
  const render = () => {
    const focused = document.activeElement;
    const wanted=[];
    for (const s of history.filter((s) =>
      s.name.toLowerCase().includes(query.value.toLowerCase()),
    )) {
      const key=s.id || s.key;
      const node=row(
        list,
        (s.unread ? "● " : "") + s.name,
        [
          s.group,
          s.parentId ? WorkbenchI18n.t("Ветка") : "",
          s.cwd?.split(/[\\/]/).filter(Boolean).at(-1),
          s.busy
            ? WorkbenchI18n.t("Выполняется")
            : s.open
              ? WorkbenchI18n.t("Открыта")
              : s.closed
                ? WorkbenchI18n.t("Закрытая вкладка")
                : s.local
                  ? WorkbenchI18n.t("Локальная сессия")
                  : "",
        ]
          .filter(Boolean)
          .join(" · "),
        () => {
          send("open", { id: s.id, key: s.key });
          close();
        },
        {existing:rows.get(key)},
      );
      rows.set(key,node);wanted.push(node);
    }
    if (!history.length)
      wanted.push(
        el("p", WorkbenchI18n.t("История загружается или пока пуста.")),
      );
    if (historyCursor) {
      more.onclick = () =>
        send("history", {
          scope: historyScope,
          query: historyQuery,
          cursor: historyCursor,
          generation: historyGeneration,
        });
      wanted.push(more);
    }
    for(const node of [...list.children])if(!wanted.includes(node))node.remove();
    wanted.forEach((node,index)=>{if(list.children[index]!==node)list.insertBefore(node,list.children[index] || null);});
    for(const [key,node] of rows)if(!wanted.includes(node))rows.delete(key);
    if(list.contains(focused) && document.activeElement!==focused)focused.focus({preventScroll:true});
  };
  query.oninput = () => {
    historyQuery = query.value;
    render();
    clearTimeout(historyTimer);
    historyTimer = setTimeout(
      () =>
        send("history", {
          scope: historyScope,
          query: historyQuery,
          generation: ++historyGeneration,
        }),
      200,
    );
  };
  scope.onchange = () => {
    historyScope = scope.value;
    send("history", {
      scope: historyScope,
      query: historyQuery,
      generation: ++historyGeneration,
    });
  };
  historyListRender = render;
  render();
  query.focus();
}
function submitText(action='send') {
  if ((!input.value.trim() && !state.attachments?.some(file=>file.kind==='image')) || sending || composerParked() || pendingModel || pendingEffort || pendingClipboardImages.size) return;
  sending = true;
  state.error=null;
  pendingSends.set(state.key, input.value);
  parkedSends.set(state.key, input.value);
  displacedSends.delete(state.key);
  updateSubmitState();
  composerDrafts.submit(state.key,input.value);
  if(!state.busy && !state.compacting && !state.followUps?.length && !state.followUpSending && action==='send'){
    const node=el('article',undefined,'item user pending-send');
    const images=el('div',undefined,'message-images');
    for(const [index,file] of (state.attachments || []).filter(file=>file.kind==='image').entries()){
      if(file.preview){
        const thumbnail=button('',WorkbenchI18n.t('Открыть изображение {0}',index+1),()=>showImagePreview(file.preview));thumbnail.className='message-image';
        const picture=el('img');picture.src=file.preview;picture.alt=WorkbenchI18n.t('Изображение {0}',index+1);thumbnail.append(picture);images.append(thumbnail);
      }else images.append(el('span',WorkbenchI18n.t('Изображение {0}',index+1),'message-image'));
    }
    if(images.children.length)node.append(images);
    node.append(el('div',input.value || WorkbenchI18n.t('Изображение')),
      el('small',WorkbenchI18n.t('Отправляю запрос…'),'pending-send-status'));
    pendingPreviews.set(state.key,{node,known:new Set(state.items.filter(item=>item.type==='userMessage').map(item=>item.id))});
  }
  send(state.compacting ? 'enqueue' : action, { text: input.value });
  draft = input.value;
  persist();
  close();
  render();
  transcriptScroll.toBottom();
}
function renderMcpForm(card, request) {
  const schema = request.params.requestedSchema;
  if (!WorkbenchForms.supported(schema)) {
    card.append(
      el(
        "p",
        WorkbenchI18n.t(
          "Схема формы пока не поддерживается. Можно отклонить запрос.",
        ),
      ),
    );
    return;
  }
  const form = el("form"),
    fields = [];
  for (const [name, field] of Object.entries(schema.properties)) {
    const label = el("label", field.title || name);
    if (field.description) label.append(el("small", field.description));
    const options = WorkbenchForms.choices(
      field.type === "array" ? field.items : field,
    );
    const control = el(options ? "select" : "input");
    control.name = name;
    control.setAttribute("aria-label", field.title || name);
    control.required = !!schema.required?.includes(name);
    if (options) {
      control.multiple = field.type === "array";
      if (!control.multiple && !control.required)
        control.append(el("option", ""));
      for (const option of options) {
        const node = el("option", option.label);
        node.value = option.value;
        node.selected = Array.isArray(field.default)
          ? field.default.includes(option.value)
          : field.default === option.value;
        control.append(node);
      }
    } else if (field.type === "boolean") {
      control.type = "checkbox";
      control.checked = field.default === true;
      control.required = false;
    } else if (["number", "integer"].includes(field.type)) {
      control.type = "number";
      control.step = field.type === "integer" ? "1" : "any";
      if (field.minimum != null) control.min = field.minimum;
      if (field.maximum != null) control.max = field.maximum;
      control.value = field.default ?? "";
    } else {
      control.type =
        field.format === "email"
          ? "email"
          : field.format === "date"
            ? "date"
            : "text";
      control.value = field.default ?? "";
      if (field.minLength != null) control.minLength = field.minLength;
      if (field.maxLength != null) control.maxLength = field.maxLength;
    }
    fields.push({ name, control, type: field.type });
    label.append(control);
    form.append(label);
  }
  const error = el("small", undefined, "form-error"),
    accept = el("button", WorkbenchI18n.t("Отправить"), "primary");
  form.append(error, accept);
  form.onsubmit = (event) => {
    event.preventDefault();
    try {
      const values = {};
      for (const { name, control, type } of fields) {
        let value =
          type === "boolean"
            ? control.checked
            : type === "array"
              ? [...control.selectedOptions].map((option) => option.value)
              : type === "number" || type === "integer"
                ? control.value === ""
                  ? undefined
                  : Number(control.value)
                : control.value;
        Object.defineProperty(values, name, { value, enumerable: true });
      }
      const content = WorkbenchForms.validate(schema, values);
      send("answer", { id: request.id, decision: "accept", content });
    } catch (problem) {
      error.textContent = problem.message;
    }
  };
  card.append(form);
}
let queuedRenderSignature = '';
function renderQueuedMessages() {
  const signature = JSON.stringify([state.key, state.followUps, state.queuePaused, state.busy, state.followUpSending, state.compacting]);
  if (signature === queuedRenderSignature) return;
  queuedRenderSignature = signature;
  queuedMessages.replaceChildren();queuedMessages.hidden=!state.followUps?.length && !state.queuePaused;
  for(const [index,item] of (state.followUps || []).entries()){
    const row=el('div',undefined,'queued-message'),text=button(item.text || WorkbenchI18n.t('Изображение'),WorkbenchI18n.t('Редактировать задачу в очереди'),()=>queuedEditor.open(item,state));
    text.className='queued-message-text';text.disabled=!!state.followUpSending || item.editable===false || !!item.deliveryUncertain;row.append(text);
    if(item.images)row.append(el('small',WorkbenchI18n.t('Изображений: {0}',item.images)));
    if(item.model)row.append(el('small',item.model,'queued-message-model'));
    if(item.deliveryUncertain)row.append(el('small',WorkbenchI18n.t(item.transferPending ? 'Перенос не завершён' : 'Доставка не подтверждена')));
    for (const [direction, label, glyph] of [[-1, 'Переместить выше', '↑'], [1, 'Переместить ниже', '↓']]) {
      const move = button(glyph, WorkbenchI18n.t(label), () => send('moveQueued', { id: item.id, direction, expectedOrder: state.followUps.map(task => task.id) }));
      move.className = 'queued-message-move';
      move.disabled = !!state.followUpSending || (direction < 0 ? index === 0 : index === state.followUps.length - 1);
      row.append(move);
    }
    if(state.busy){
      const steer=button(WorkbenchI18n.t('Скорректировать'),WorkbenchI18n.t('Добавить к текущей задаче'),()=>send('steerQueued',{id:item.id}));
      steer.className='queued-message-steer';steer.disabled=!!state.followUpSending || !!state.compacting || !!item.deliveryUncertain;row.append(steer);
    }
    const transferLabel=WorkbenchI18n.t(item.transferPending ? 'Открыть новую сессию' : 'Отправить в новой сессии');
    const transfer=button('↗',transferLabel,()=>send('transferQueued',{id:item.id,expectedText:item.text,expectedAttachmentIds:(item.attachments || []).map(file=>file.id)}));
    transfer.className='queued-message-transfer';
    transfer.disabled=!!state.followUpSending || (item.editable===false || !!item.deliveryUncertain) && !item.transferPending;
    row.append(transfer);
    const remove=button('×',WorkbenchI18n.t('Удалить из очереди'),()=>send('removeQueued',{id:item.id}));remove.disabled=!!state.followUpSending;row.append(remove);queuedMessages.append(row);
  }
  if(state.followUps?.length || state.queuePaused){
    const status=el('div',undefined,'queued-message-footer');status.append(el('small',WorkbenchI18n.t('В очереди: {0}',state.followUps.length)));
    const pauseLabel = WorkbenchI18n.t(state.queuePaused ? 'Продолжить очередь' : 'Пауза очереди');
    const pause = button(pauseLabel, pauseLabel, () => send('queuePause', { paused: !state.queuePaused }));
    pause.className = 'queued-message-pause';pause.setAttribute('aria-pressed', String(!!state.queuePaused));status.append(pause);
    if (state.queuePaused) status.append(el('small', WorkbenchI18n.t('Очередь на паузе')));
    if(!state.busy && state.followUps?.length){const run=button(WorkbenchI18n.t('Отправить следующее'),WorkbenchI18n.t('Отправить следующее'),()=>send('sendQueued'));run.disabled=!!state.followUpSending;run.className='queued-message-run';status.append(run);}
    queuedMessages.append(status);
  }
}
function render() {
  const scrollSnapshot = transcriptScroll.capture(state.key);
  taskPreflight.update(state);
  resizeComposer();
  renderQuotaWarning();
  renderReview();
  if(hydrated)queuedEditor.update(state);
  renderQueuedMessages();
  updateActivity();
  if (
    pendingEffort &&
    (pendingEffort.key !== state.key ||
      pendingEffort.model !== state.model ||
      pendingEffort.effort === state.effort ||
      state.error)
  )
    pendingEffort = null;
  if (pendingModel && (state.model === pendingModel || state.error))
    pendingModel = null;
  renderContext();
  reasoningView?.update();
  modelListRender?.();
  modeView?.update();
  fastView?.update();
  access.classList.toggle("danger-action", state.prefs.access === "full");
  access.classList.toggle("full-access-warning", WorkbenchModes.current(state.prefs).id === "full");
  sessionTabs.update(state);
  root.classList.toggle(
    "is-empty",
    !state.items.length && !state.requests.length && !state.error && !state.busy && !sending && !pendingPreviews.has(state.key),
  );
  model.replaceChildren(
    el(
      "span",
      (currentModel()?.displayName ||
        state.model ||
        WorkbenchI18n.t("Выбрать модель")) +
        (state.effort
          ? " \u00b7 " + WorkbenchControls.label(state.effort)
          : "") + (state.prefs.fast && WorkbenchSpeed.fastTier(currentModel()) ? ' · Fast' : ''),
      "button-label",
    ),
  );
  model.title =
    WorkbenchI18n.t("Модель: ") +
    (currentModel()?.displayName || state.model || WorkbenchI18n.t("выбрать"));
  access.textContent = {
    read: WorkbenchI18n.t("Чтение"),
    workspace: WorkbenchI18n.t("Проект"),
    full: WorkbenchI18n.t("Полный доступ"),
  }[state.prefs.access];
  ide.classList.toggle("active", state.prefs.ide);
  ide.setAttribute("aria-pressed", String(state.prefs.ide));
  updateSubmitState();
  model.disabled = !!pendingModel;
  input.placeholder = state.prefs.plan
    ? WorkbenchI18n.t("Обсудим архитектуру и план…")
    : composerDock.classList.contains("has-changes")
      ? WorkbenchI18n.t("Запросите внесение дополнительных изменений")
      : WorkbenchI18n.t("Что нужно сделать в этом проекте?");
  const activeMode = state.prefs.pendingMode ? WorkbenchModes.modes.find(mode=>mode.id===state.prefs.pendingMode) || WorkbenchModes.current(state.prefs) : WorkbenchModes.current(state.prefs);
  access.replaceChildren(
    icon(activeMode.icon),
    el(
      "span",
      {
        manual: WorkbenchI18n.t("Вручную"),
        workspace: WorkbenchI18n.t("Проект"),
        plan: WorkbenchI18n.t("План"),
        auto: WorkbenchI18n.t("Авто"),
        full: WorkbenchI18n.t("Полный доступ"),
      }[activeMode.id]+(state.prefs.pendingMode?' · '+WorkbenchI18n.t('ожидает'):''),
      "button-label",
    ),
  );
  access.title =
    WorkbenchI18n.t(activeMode.label) +
    " — " +
    WorkbenchI18n.t(activeMode.description);
  if(state.prefs.pendingMode)access.title+=' · '+WorkbenchI18n.t('Изменение режима применится после завершения текущего ответа.');
  attachments.replaceChildren();
  for (const file of state.attachments || []) {
    if(file.preview && file.kind==='image'){
      const wrapper=el('div',undefined,'image-attachment');
      const previewButton=el('button',undefined,'image-preview');previewButton.type='button';previewButton.title=WorkbenchI18n.t('Открыть изображение');previewButton.setAttribute('aria-label',previewButton.title);
      const preview=el('img');preview.src=file.preview;preview.alt=WorkbenchI18n.t('Вставленное изображение');previewButton.append(preview);
      previewButton.onclick=()=>showImagePreview(file.preview);
      const remove=el('button','×','image-attachment-remove');remove.type='button';remove.title=WorkbenchI18n.t('Удалить вложение');remove.setAttribute('aria-label',remove.title);
      remove.onclick=()=>send('removeAttachment',{id:file.id,path:file.path});
      wrapper.append(previewButton,remove);attachments.append(wrapper);continue;
    }
    const b = el(
      "button",
      (file.kind === "image" ? "▧ " : file.kind === "selection" ? "⌘ " : "") +
        file.name +
        " ×",
    );
    b.title=WorkbenchI18n.t('Удалить вложение');b.setAttribute('aria-label',b.title);b.type='button';
    b.onclick = () =>
      send("removeAttachment", { id: file.id, path: file.path });
    attachments.append(b);
  }
  if(hydrated)questionPanel.update(state);
  const preview=pendingPreviews.get(state.key);
  if(preview && state.items.some(item=>item.type==='userMessage' && !preview.known.has(item.id)))pendingPreviews.delete(state.key);
  messageList.update(state, { pending: pendingPreviews.get(state.key)?.node, scrollSnapshot });
  requestAnimationFrame(updateJump);
  if (pendingReveal && revealItem(pendingReveal)) pendingReveal = null;
  const focused = document.activeElement,
    focusRequest = focused?.closest(".approval")?.dataset.requestId,
    focusName = focused?.name;
  for (const card of alerts.querySelectorAll(".approval")) {
    const values = Object.create(null);
    for (const field of card.querySelectorAll("input,select"))
      values[field.name] =
        field.type === "checkbox"
          ? field.checked
          : field.multiple
            ? [...field.selectedOptions].map((option) => option.value)
            : field.value;
    approvalDrafts.set(card.dataset.requestId, values);
  }
  for (const id of approvalDrafts.keys())
    if (!state.requests.some((request) => String(request.id) === id))
      approvalDrafts.delete(id);
  alerts.replaceChildren();
  if (state.error) {
    const error = el("div", state.error, "error");
    const retry = el("button", WorkbenchI18n.t("Переподключиться"));
    retry.onclick = () => send("retry");
    error.append(retry);
    alerts.append(error);
  }
  for (const request of state.requests) {
    if(request.method==='item/tool/requestUserInput')continue;
    const card = el("div", undefined, "approval");
    card.dataset.requestId = String(request.id);
    card.append(
      el(
        "strong",
        request.method.includes("requestUserInput")
          ? WorkbenchI18n.t("Вопрос Codex")
          : request.method === "mcpServer/elicitation/request"
            ? request.params.serverName || WorkbenchI18n.t("Форма MCP")
            : WorkbenchI18n.t("Требуется разрешение"),
      ),
    );
    if (request.method !== "item/tool/requestUserInput") {
      if (request.params.reason) card.append(el("p", request.params.reason));
      if (request.method === "item/commandExecution/requestApproval") {
        const command = request.params.command;
        if (command)
          card.append(
            el(
              "pre",
              Array.isArray(command) ? command.join(" ") : String(command),
            ),
          );
        if (request.params.cwd)
          card.append(el("small", request.params.cwd, "request-location"));
      } else if (request.method === "item/fileChange/requestApproval") {
        if (request.params.grantRoot)
          card.append(
            el("small", request.params.grantRoot, "request-location"),
          );
      } else if (request.method === "item/permissions/requestApproval") {
        card.append(
          el("pre", JSON.stringify(request.params.permissions || {}, null, 2)),
        );
      }
      const supported = [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/permissions/requestApproval",
        ].includes(request.method),
        decisions = request.params.availableDecisions;
      if (supported) {
        if (!decisions || decisions.includes("accept")) {
          const allow = el(
            "button",
            request.method === "item/permissions/requestApproval"
              ? WorkbenchI18n.t("Разрешить на этот ход")
              : WorkbenchI18n.t("Разрешить один раз"),
            "primary",
          );
          allow.onclick = () =>
            send("answer", { id: request.id, decision: "accept" });
          card.append(allow);
        }
        if (
          request.method !== "item/permissions/requestApproval" &&
          (!decisions || decisions.includes("acceptForSession"))
        ) {
          const session = el("button", WorkbenchI18n.t("Разрешить для сессии"));
          session.className = "warning-action";
          session.onclick = () =>
            send("answer", { id: request.id, decision: "acceptForSession" });
          card.append(session);
        }
      } else if (
        request.method === "mcpServer/elicitation/request" &&
        request.params.mode === "form"
      ) {
        card.append(el("p", request.params.message));
        renderMcpForm(card, request);
      } else if (
        request.method === "mcpServer/elicitation/request" &&
        request.params.mode === "url"
      ) {
        card.append(
          el("p", request.params.message),
          el("p", request.params.url),
        );
        const visit = el("button", WorkbenchI18n.t("Открыть ссылку")),
          done = el("button", WorkbenchI18n.t("Готово"));
        visit.onclick = () => send("requestUrl", { id: request.id });
        done.onclick = () =>
          send("answer", { id: request.id, decision: "accept" });
        card.append(visit, done);
      } else
        card.append(
          el(
            "p",
            WorkbenchI18n.t(
              "Этот тип расширенного запроса пока не поддерживается. Можно отклонить и продолжить работу.",
            ),
          ),
        );
      const deny = el("button", WorkbenchI18n.t("Отклонить"));
      deny.onclick = () =>
        send("answer", { id: request.id, decision: "decline" });
      card.append(deny);
    }
    alerts.append(card);
    const values = approvalDrafts.get(String(request.id));
    if (values)
      for (const field of card.querySelectorAll("input,select"))
        if (Object.hasOwn(values, field.name)) {
          if (field.type === "checkbox") field.checked = values[field.name];
          else if (field.multiple)
            for (const option of field.options)
              option.selected = values[field.name].includes(option.value);
          else field.value = values[field.name];
          if (focusRequest === String(request.id) && focusName === field.name)
            field.focus();
        }
  }
  transcriptScroll.afterUpdate();
  persist();
  if (menuKind === "commands" && commandMenuSignature !== commandsSignature()) {
    commandMenuSignature = commandsSignature();
    commandMenuRender?.();
  } else if(menuKind==='client' && cliMenuSignature!==JSON.stringify(state.cli)) {
    clientMenuRender?.();
  } else if (menuKind === "account" && accountMenuSignature!==accountSignature()) {
    const top=menu.scrollTop;
    close();
    open("account",false);
    menu.scrollTop=top;
  } else if (
    menuKind === "limits" &&
    limitsMenuSignature !== JSON.stringify([state.limits, state.account])
  )
    renderLimits();
  else if (
    menuKind === "bookmarks" &&
    bookmarksSignature !== JSON.stringify(state.bookmarks || [])
  )
    renderBookmarks();
}
const scrollPositions = new Map();
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === 'queuedAttachmentsResult') { queuedEditor.attachmentsResult(msg);return; }
  if (msg.type === 'queuedEditResult') { queuedEditor.finish(msg);return; }
  if (msg.type === 'toggleResult') {
    toggles.finish(msg);
    return;
  }
  if(msg.type==='pasteImageResult'){pendingClipboardImages.delete(msg.requestId);updateSubmitState();return;}
  if (msg.type === "state") {
    if (state.key !== msg.data.key) {
      toggles.reset();
      close();
    }
    const changed = !!state.key && state.key !== msg.data.key;
    let cachedDraft=input.value;
    if (changed) {
      if(imageViewer?.open)imageViewer.close();
      pendingReveal = null;
      sessionTabs.finishRename(true);
      localDrafts[state.key] = input.value;
      scrollPositions.set(state.key, messages.scrollTop);
      historyGeneration++;
      sending = false;
      cachedDraft = Object.hasOwn(localDrafts, msg.data.key)
        ? localDrafts[msg.data.key]
        : undefined;
    }
    const reconciled=composerDrafts.receive(msg.data.key,cachedDraft,msg.data.draft || '');
    input.value=reconciled.text;
    if(reconciled.delivered){
      sending=false;pendingSends.delete(msg.data.key);pendingPreviews.delete(msg.data.key);
      parkedSends.delete(msg.data.key);displacedSends.delete(msg.data.key);
    }
    if (!historyScope) historyScope = msg.data.historyScope === "all" ? "all" : "workspace";
    hydrated = true;
    state = { ...state, ...msg.data };
    document.documentElement.dataset.controlMotion =
      ['on', 'off'].includes(state.controlMotion) ? state.controlMotion : 'auto';
    document.documentElement.dataset.chatWidth=state.chatWidth==='compact'?'compact':'wide';
    if (state.error) {
      sending = false;pendingPreviews.delete(state.key);pendingSends.delete(state.key);parkedSends.delete(state.key);
      // The failed text was typed over while hidden: give it back next to the new draft.
      const displaced=displacedSends.get(state.key);
      displacedSends.delete(state.key);
      if(displaced && input.value!==displaced){
        input.value=input.value ? displaced+'\n\n'+input.value : displaced;
        composerDrafts.edit(state.key);persist();send('draft',{text:input.value});
      }
    }
    render();
    if (changed)
      transcriptScroll.restore(scrollPositions.get(state.key) ?? messages.scrollHeight);
  } else if (msg.type === "sent") {
    const key = msg.key || state.key,
      submitted = msg.text ?? pendingSends.get(key);
    // A `sent` for another message (e.g. an MCP task) must not drop this send's recovery text.
    const own=msg.text===undefined || msg.text===(parkedSends.get(key) ?? displacedSends.get(key));
    pendingSends.delete(key);
    if(own){parkedSends.delete(key);displacedSends.delete(key);}
    if(msg.consumeDraft===false)composerDrafts.edit(key);
    if (key !== state.key) {
      if (msg.consumeDraft!==false && composerDrafts.canConsume(key,submitted,localDrafts[key])) {
        localDrafts[key] = "";
        composerDrafts.consumed(key);
        persist();
      } else if(msg.consumeDraft===false)persist();
      return;
    }
    sending = false;
    if (msg.consumeDraft!==false && composerDrafts.canConsume(key,submitted ?? draft,input.value)) {
      input.value = "";
      composerDrafts.consumed(key);
    }
    resizeComposer();
    updateSubmitState();
    draft = "";
    persist();
  } else if (msg.type === "history") {
    if (
      (msg.key && msg.key !== state.key) ||
      (msg.generation !== undefined && msg.generation !== historyGeneration)
    )
      return;
    const rows = msg.append ? [...history, ...msg.data] : msg.data;
    history = [
      ...new Map(rows.map((row) => [row.id || row.key, row])).values(),
    ];
    historyCursor = msg.cursor;
    if (menuKind === "history") renderHistory();
  } else if (msg.type === "projectFiles") {
    if (
      msg.key !== state.key ||
      msg.generation !== filesGeneration ||
      menuKind !== "files"
    )
      return;
    fileResults = msg.files;
    fileListView?.render(fileListView.query, false, msg.truncated);
  } else if (msg.type === "skills") {
    if (
      msg.key !== state.key ||
      msg.generation !== skillsGeneration ||
      menuKind !== "skills"
    )
      return;
    skills = msg.skills;
    skillsLoading = false;
    skillsErrors = msg.errors;
    renderSkills();
  } else if (msg.type === "bookmarkDetails") {
    if (msg.key === state.key && menuKind === "bookmarks") {
      selectedBookmark = msg.bookmark;
      renderBookmarks();
    }
  } else if (msg.type === "revealItem") {
    if (msg.key === state.key) {
      pendingReveal = msg.itemId;
      if (revealItem(pendingReveal)) pendingReveal = null;
    }
  } else if (msg.type === "copied") {
    if (!msg.key || msg.key === state.key)
      messageList.copied(msg.itemId, msg.codeIndex);
  } else if (msg.type === "rename")
    sessionTabs.startRename(msg.key || state.key);
  else if (msg.type === "open") open(msg.action);
});
window.addEventListener("resize", () => {
  resizeComposer();
  placeMenu();
  updateJump();
});
const composerObserver = new ResizeObserver(() => {
  const panelHeight = [composerDock, alerts].reduce((height, panel) => {
    const style = getComputedStyle(panel);
    return height + panel.getBoundingClientRect().height + parseFloat(style.marginTop || 0) + parseFloat(style.marginBottom || 0);
  }, 0);
  root.style.setProperty('--transcript-panel-height', Math.ceil(panelHeight) + 'px');
  placeMenu();
  updateJump();
});
composerObserver.observe(composerDock);
composerObserver.observe(alerts);
window.addEventListener('pagehide', () => composerObserver.disconnect(), { once: true });
input.addEventListener('paste',event=>{
  const images=Array.from(event.clipboardData?.items || []).filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
  if(!images.length)return;
  event.preventDefault();
  const key=state.key;
  for(const file of images){
    if(!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type)||file.size>20*1024*1024){
      state.error=WorkbenchI18n.t('Поддерживаются PNG, JPEG, GIF и WebP до 20 МБ.');render();continue;
    }
    const requestId='paste-'+Date.now()+'-'+Math.random().toString(36).slice(2);pendingClipboardImages.add(requestId);updateSubmitState();
    const reader=new FileReader();
    reader.onload=()=>{
      if(state.key!==key){pendingClipboardImages.delete(requestId);updateSubmitState();return;}
      send('pasteImage',{requestId,dataUrl:reader.result});
    };
    reader.onerror=()=>{pendingClipboardImages.delete(requestId);state.error=WorkbenchI18n.t('Не удалось прочитать изображение из буфера обмена.');render();};
    reader.readAsDataURL(file);
  }
});
input.addEventListener('beforeinput',event=>{
  if(!composerParked())return;
  const key=state.key;
  displacedSends.set(key,parkedSends.get(key));
  parkedSends.delete(key);
  if(event.inputType==='insertCompositionText'){input.value='';return;}
  event.preventDefault();
  input.value=event.inputType==='insertLineBreak' || event.inputType==='insertParagraph' ? '\n' :
    event.inputType.startsWith('insert') ? event.data ?? event.dataTransfer?.getData('text/plain') ?? '' : '';
  input.dispatchEvent(new Event('input',{bubbles:true}));
});
input.addEventListener("input", () => {
  composerDrafts.edit(state.key);
  if (input.value === "/") {
    input.value = "";
    open("commands");
  } else {
    const prefix = input.value.slice(0, input.selectionStart),
      match = prefix.match(/(?:^|\s)@([^\s@]*)$/);
    if (match) {
      mention = {
        start: prefix.length - match[1].length - 1,
        end: input.selectionStart,
        query: match[1],
      };
      if (menuKind !== "files") open("files");
      else searchProjectFiles(mention.query);
    } else if (menuKind === "files" && mention) close();
  }
  persist();
  send("draft", { text: input.value });
  resizeComposer();
  updateSubmitState();
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (menuKind === "files" && mention)
      menu.querySelector(".menu-row")?.click();
    else submitText(event.altKey && state.busy ? 'enqueue':'send');
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if(imageViewer?.open)return;
    close();
    input.focus();
  }
  if (
    menu &&
    ["ArrowDown", "ArrowUp"].includes(event.key) &&
    event.target.type !== "range"
  ) {
    event.preventDefault();
    const buttons = [...menu.querySelectorAll(".menu-row:not(:disabled)")];
    const i = buttons.indexOf(document.activeElement),
      next =
        i < 0
          ? event.key === "ArrowDown"
            ? 0
            : buttons.length - 1
          : (i + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[next]?.focus();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (
    menu &&
    !menu.contains(event.target) &&
    !menuTriggers.has(event.target.closest?.("button")) &&
    !(menuKind === "files" && mention && event.target === input)
  )
    close();
});
render();
send("ready");
