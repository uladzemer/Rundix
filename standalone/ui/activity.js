// A single live footer for the active turn. It never invents completed work.
class WorkbenchActivity {
  constructor({ icon }) {
    this.icon = icon;
    this.timer = null;
    this.owner = null;
    this.phase = null;
    this.disposed = false;
    this.motion = matchMedia('(prefers-reduced-motion: reduce)');
    this.onMotion = () => this.tick();
    this.motion.addEventListener('change', this.onMotion);
    const node = (tag, className) => {
      const element = document.createElement(tag);element.className = className;return element;
    };
    this.element = node('div', 'item activity-status');
    this.element.setAttribute('role', 'status');this.element.hidden = true;
    const mark = node('span', 'activity-mark');mark.setAttribute('aria-hidden', 'true');
    const orbit = node('span', 'activity-spinner');
    for (let index = 0; index < 3; index++) orbit.append(node('span', 'activity-petal'));
    this.glyph = node('span', 'activity-glyph');mark.append(orbit, this.glyph);
    this.label = node('span', 'activity-label');this.label.setAttribute('aria-hidden', 'true');
    this.time = node('span', 'activity-time');this.time.setAttribute('aria-hidden', 'true');
    this.announcement = node('span', 'activity-announcement');
    this.element.append(mark, this.label, this.time, this.announcement);
  }
  update(state, { sending = false } = {}) {
    if (this.disposed) return;
    const visible = state.busy || sending;
    this.policy = ['on', 'off'].includes(state.activityMotion) ? state.activityMotion : 'auto';
    this.element.dataset.motion = this.policy;
    this.element.hidden = !visible;
    if (!visible) {
      clearInterval(this.timer);this.timer = null;this.owner = null;this.phase = null;
      return;
    }
    const preparing = sending && !state.busy;
    const owner = state.key + ':' + (preparing ? 'sending' : state.turnId || state.turnStartedAt || 'active');
    const now = Date.now();
    if (owner !== this.owner) {
      this.owner = owner;this.phase = null;
      this.started = !preparing && Number.isFinite(state.turnStartedAt) ? state.turnStartedAt : now;
    }
    // Unowned history cannot prove which turn is running, including during turn/start.
    const items = state.turnId ? state.items.filter(item => item.turnId === state.turnId) : [];
    const current = items.findLast(item => item.status === 'inProgress') || items.at(-1);
    let phase = preparing ? 'sending' : state.requests?.length ? 'waiting' : state.compacting ? 'compacting' : current?.type;
    if (!preparing && !state.requests?.length && !state.compacting && current?.status && current.status !== 'inProgress') phase = 'working';
    if (phase === 'agentMessage' && current?.phase !== 'final') phase = 'working';
    if(!preparing && !state.requests?.length && !state.compacting && state.retrying)phase='retrying';
    const stages = {
      sending: ['send', ['Отправляю запрос…']],
      retrying: ['send', ['Codex повторяет запрос…']],
      waiting: ['hand', ['Ожидаю вашего ответа…']],
      compacting: ['plan', ['Сжимаю контекст…', 'Обновляю контекст…']],
      contextCompaction: ['plan', ['Сжимаю контекст…', 'Обновляю контекст…']],
      commandExecution: ['code', ['Выполняю команду…', 'Команда выполняется…', 'Ожидаю завершения команды…']],
      fileChange: ['file', ['Вношу изменения…', 'Редактирую файлы…']],
      webSearch: ['plan', ['Выполняю поиск…', 'Ищу информацию…']],
      mcpToolCall: ['bolt', ['Выполняю действие инструмента…', 'Инструмент работает…']],
      reasoning: ['effort', ['Размышляю…', 'Обдумываю решение…', 'Анализирую задачу…', 'Сопоставляю варианты…']],
      agentMessage: ['assistant', ['Формирую ответ…', 'Пишу ответ…']],
      working: ['assistant', ['Работаю над задачей…', 'Продолжаю работу…', 'Готовлю следующий шаг…']],
    };
    if (!Object.hasOwn(stages, phase)) phase = 'working';
    if (this.phase !== phase) {
      this.phase = phase;this.phaseStarted = now;
      const [glyph, words] = stages[phase];this.words = words;
      this.glyph.replaceChildren(this.icon(glyph));
      this.announcement.textContent = WorkbenchI18n.t(words[0]);
      this.element.dataset.phase = phase;
      this.element.classList.toggle('is-waiting', phase === 'waiting');
    }
    this.tick();
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
  }
  tick() {
    if (this.disposed || this.element.hidden || !this.words) return;
    const now = Date.now();
    const still = this.policy === 'off' || this.policy !== 'on' && this.motion.matches;
    const index = still ? 0 : Math.floor(Math.max(0, now - this.phaseStarted) / 3000) % this.words.length;
    const label = WorkbenchI18n.t(this.words[index]);
    if (this.label.textContent !== label) this.label.textContent = label;
    const elapsed = Math.max(0, Math.floor((now - this.started) / 1000));
    this.time.textContent = elapsed < 60 ? WorkbenchI18n.t('{0} с', elapsed) : WorkbenchI18n.t('{0} мин {1} с', Math.floor(elapsed / 60), elapsed % 60);
  }
  dispose() {
    this.disposed = true;clearInterval(this.timer);this.timer = null;
    this.motion.removeEventListener('change', this.onMotion);this.element.hidden = true;
  }
}
