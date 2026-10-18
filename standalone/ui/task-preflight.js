(function (root) {
  const t = (text) => root.WorkbenchI18n.t(text);
  const labels = {
    goal: "Цель",
    scope: "Входит в задачу",
    nonGoals: "Вне задачи",
    constraints: "Ограничения",
    assumptions: "Допущения",
    criteria: "Критерии готовности и проверки",
    steps: "План выполнения",
    openQuestions: "Открытые вопросы",
  };
  class TaskPreflight {
    constructor(send) {
      this.element = document.createElement("section");
      this.element.className = "task-preflight";
      this.element.hidden = true;
      this.send = send;
      this.details = document.createElement("details");
      this.summary = document.createElement("summary");
      this.content = document.createElement("div");
      this.details.append(this.summary, this.content);
      this.approve = document.createElement("button");
      this.approve.type = "button";
      this.approve.className = "primary";
      this.approve.textContent = t("Согласовать и выполнить");
      this.approve.onclick = () => {
        this.approve.disabled = true;
        send("approveTask", { id: this.task.id, revision: this.task.revision });
      };
      this.element.append(this.details, this.approve);
    }
    update(state) {
      const task = state.preflight;
      this.task = task;
      this.element.hidden = !task?.enabled;
      if (!task?.enabled) return;
      const phases = {
        draft: "Подготовка задачи",
        clarifying: "Уточнение задачи",
        ready: "План на согласовании",
        executing: "Выполнение согласованного плана",
        review: "Проверьте результат по критериям",
      };
      this.summary.textContent = t(phases[task.phase] || phases.clarifying);
      const signature = JSON.stringify([
        task.id,
        task.revision,
        task.phase,
        task.spec,
        task.skipped,
      ]);
      if (signature !== this.signature) {
        this.signature = signature;
        this.content.replaceChildren();
        const note = document.createElement("p");
        note.textContent = t(
          "До согласования — только чтение. Внешние интеграции отключены на весь экспериментальный чат.",
        );
        this.content.append(note);
        if (task.spec)
          for (const [key, label] of Object.entries(labels)) {
            const values = key === "goal" ? [task.spec[key]] : task.spec[key];
            if (!values?.length) continue;
            const heading = document.createElement("strong");
            heading.textContent = t(label);
            const list = document.createElement("ul");
            for (const value of values) {
              const item = document.createElement("li");
              item.textContent = value;
              list.append(item);
            }
            this.content.append(heading, list);
          }
        if (task.skipped) {
          const note = document.createElement("p");
          note.textContent = t(
            "Вопросы пропущены. Напишите уточнение; пропуск не разрешает выполнение.",
          );
          this.content.append(note);
        }
        this.details.open = task.phase === "ready";
      }
      this.approve.hidden = task.phase !== "ready";
      this.approve.disabled =
        !!state.busy || !!state.followUpSending || !!state.followUps?.length;
    }
  }
  root.WorkbenchTaskPreflight = TaskPreflight;
})(globalThis);
