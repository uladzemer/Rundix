// Account quota presentation, separate from composer and session state.
function quotaColor(remaining) {
  return remaining <= 10 ? 'danger-action' : remaining <= 25 ? 'warning-action' : 'quota-healthy';
}
class WorkbenchQuotaWarningView {
  constructor({ el, button, open, dismissals, onDismiss }) {
    this.dismissals = dismissals;
    this.timer = null;
    this.disposed = false;
    this.element = el('section', undefined, 'quota-warning');
    this.element.hidden = true;
    this.element.setAttribute('role', 'status');
    this.element.setAttribute('aria-live', 'polite');
    this.title = el('strong');
    this.reset = el('small');
    const text = el('span');
    text.append(this.title, this.reset);
    this.details = button('', WorkbenchI18n.t('Лимиты Codex'), () => open('limits'));
    this.details.className = 'quiet-button';
    this.details.append(text);
    const close = button('×', WorkbenchI18n.t('Закрыть предупреждение о лимитах'), () => {
      this.dismissals.set(this.key, this.band);
      while (this.dismissals.size > 64) this.dismissals.delete(this.dismissals.keys().next().value);
      this.render(this.state);
      onDismiss();
    });
    close.className = 'icon-button quota-warning-close';
    this.element.append(this.details, close);
  }
  render(state) {
    if (this.disposed) return;
    this.state = state;
    const now = Date.now();
    const warning = state.account && !state.authBusy && !state.loginPending
      ? WorkbenchLimits.lowFiveHour(state.limits, now) : null;
    const key = warning ? JSON.stringify([state.account?.email || state.account?.type || 'local', warning.bucketName, warning.resetsAt || null]) : null;
    const band = warning ? Math.ceil(warning.remaining / 5) * 5 : null;
    const dismissed = this.dismissals.get(key);
    this.element.hidden = !warning || dismissed !== undefined && band >= dismissed;
    if (this.element.hidden) {
      clearInterval(this.timer);
      this.timer = null;
      return;
    }
    this.key = key;
    this.band = band;
    this.element.classList.toggle('quota-warning-critical', warning.remaining <= 5);
    const number = new Intl.NumberFormat(navigator.language || WorkbenchI18n.language, { maximumFractionDigits: 1 });
    const percent = value => number.format(Math.floor(value * 10) / 10);
    const labels = [WorkbenchI18n.t('5 ч: {0}%', percent(warning.remaining))];
    if (Number.isFinite(warning.weeklyRemaining)) labels.push(WorkbenchI18n.t('Неделя: {0}%', percent(warning.weeklyRemaining)));
    if (state.limits.buckets.length > 1 && warning.bucketName) labels.push(warning.bucketName);
    this.title.textContent = labels.join(' · ');
    this.reset.hidden = !Number.isFinite(warning.resetsAt);
    const minutes = Math.max(1, Math.ceil((warning.resetsAt * 1000 - now) / 60000));
    const hours = Math.floor(minutes / 60), remainder = minutes % 60;
    const duration = hours ? WorkbenchI18n.t('{0} ч {1} мин', hours, remainder) : WorkbenchI18n.t('{0} мин', minutes);
    this.reset.textContent = this.reset.hidden ? '' : WorkbenchI18n.t('Сброс через {0}', duration);
    this.details.title = [this.title.textContent, this.reset.textContent].filter(Boolean).join(' · ');
    this.details.setAttribute('aria-label', this.details.title);
    // Refresh the countdown without re-rendering the conversation or fetching quotas.
    if (!this.timer) this.timer = setInterval(() => this.render(this.state), 60000);
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.timer = null;
    this.state = null;
  }
}

class WorkbenchLimitsView {
  constructor({ el, send }) {
    this.el = el;
    this.send = send;
  }
  render(target, state) {
    const { el, send } = this;
    target.classList.add("limits-menu");
    const data = state.limits || {},
      buckets = data.buckets || [];
    for (const bucket of buckets) {
      const group = el("section", undefined, "limit-bucket");
      if (buckets.length > 1) group.append(el("strong", bucket.name));
      for (const window of bucket.windows) {
        const label =
          window.minutes === 300
            ? WorkbenchI18n.t("5 часов")
            : window.minutes === 10080
              ? WorkbenchI18n.t("Еженедельно")
              : window.minutes
                ? window.minutes + " " + WorkbenchI18n.t("мин")
                : WorkbenchI18n.t(
                    window.key === "primary"
                      ? "Основное окно"
                      : "Дополнительное окно",
                  );
        const row = el("div", undefined, "limit-window"),
          heading = el("div");
        heading.append(
          el("span", label),
          el(
            "strong",
            Math.round(window.remaining) + "% " + WorkbenchI18n.t("осталось"),
            quotaColor(window.remaining),
          ),
        );
        const meter = el("meter");
        meter.min = 0;
        meter.max = 100;
        meter.low = 10;
        meter.high = 25;
        meter.optimum = 100;
        meter.value = window.remaining;
        meter.setAttribute("aria-label", label);
        row.append(heading, meter);
        if (window.resetsAt)
          row.append(
            el(
              "small",
              WorkbenchI18n.t("Сброс:") +
                " " +
                new Date(window.resetsAt * 1000).toLocaleString(
                  WorkbenchI18n.language,
                  {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  },
                ),
            ),
          );
        group.append(row);
      }
      if (bucket.blocked)
        group.append(
          el("p", WorkbenchI18n.t("Лимит достигнут"), "danger-action"),
        );
      target.append(group);
    }
    if (!buckets.some((b) => b.windows.length))
      target.append(
        el(
          "p",
          WorkbenchI18n.t(
            data.loading
              ? "Загрузка лимитов…"
              : !state.account
                ? "Войдите в Codex через /account."
                : "Лимиты недоступны для этого аккаунта.",
          ),
        ),
      );
    if (data.error)
      target.append(
        el(
          "p",
          WorkbenchI18n.t("Не удалось обновить лимиты. Повторите попытку."),
        ),
      );
    if (data.updatedAt)
      target.append(
        el(
          "small",
          WorkbenchI18n.t("Обновлено:") +
            " " +
            new Date(data.updatedAt).toLocaleTimeString(WorkbenchI18n.language),
        ),
      );
    const refresh = el("button", WorkbenchI18n.t("Обновить"), "quiet-button");
    refresh.disabled = !!data.loading;
    refresh.onclick = () => send("limits");
    target.append(refresh);
  }
}

class WorkbenchAccountUsageView {
  constructor({ el }) {
    this.el = el;
    this.date = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  render(target, data, { loading = false } = {}) {
    const { el } = this,
      root = el("span", undefined, "account-usage");
    const buckets = data?.buckets || [];
    for (const bucket of buckets) {
      if (buckets.length > 1)
        root.append(el("span", bucket.name, "account-usage-bucket"));
      for (const window of bucket.windows || []) {
        const label =
          window.minutes === 300
            ? WorkbenchI18n.t("5 часов")
            : window.minutes === 10080
              ? WorkbenchI18n.t("Еженедельно")
              : window.minutes
                ? window.minutes + " " + WorkbenchI18n.t("мин")
                : WorkbenchI18n.t(
                    window.key === "primary"
                      ? "Основное окно"
                      : "Дополнительное окно",
                  );
        const row = el("span", undefined, "account-usage-window");
        row.append(el("span", label));
        const remaining = el(
          "strong",
          Math.round(window.remaining) + "% " + WorkbenchI18n.t("осталось"),
          "account-usage-remaining",
        );
        remaining.classList.add(quotaColor(window.remaining));
        row.append(remaining);
        if (
          Number.isFinite(window.resetsAt) &&
          !Number.isNaN(new Date(window.resetsAt * 1000).getTime())
        ) {
          const date = new Date(window.resetsAt * 1000),
            time = el(
              "time",
              WorkbenchI18n.t("Сброс:") + " " + this.date.format(date),
              "account-usage-reset",
            );
          time.dateTime = date.toISOString();
          time.title = date.toLocaleString();
          row.append(time);
        } else
          row.append(
            el(
              "span",
              WorkbenchI18n.t("Время сброса не передано"),
              "account-usage-reset",
            ),
          );
        root.append(row);
      }
    }
    if (!buckets.some((bucket) => bucket.windows?.length))
      root.append(
        el(
          "span",
          WorkbenchI18n.t(
            loading
              ? "Загрузка лимитов…"
              : "Лимиты недоступны для этого аккаунта.",
          ),
          "account-usage-status",
        ),
      );
    if (data?.error)
      root.append(
        el(
          "span",
          WorkbenchI18n.t(
            data.error === "sign-in-required"
              ? "Обновите вход для чтения лимитов"
              : "Не удалось обновить лимиты. Повторите попытку.",
          ),
          "account-usage-status warning-action",
        ),
      );
    if (data?.updatedAt)
      root.title =
        WorkbenchI18n.t("Обновлено:") +
        " " +
        new Date(data.updatedAt).toLocaleString();
    target.append(root);
    return root;
  }
}
