// Native VS Code editor tabs own sessions. This is only the in-chat action bar.
class WorkbenchTabs {
  constructor({ icon, send, closeMenus }) {
    this.send = send;
    this.closeMenus = closeMenus;
    this.element = document.createElement("nav");
    this.element.className = "session-toolbar";
    this.element.setAttribute("aria-label", WorkbenchI18n.t("Сессии Rundix"));
    const action = (label, iconName, handler, cls) => {
      const button = document.createElement("button");
      button.className = "icon-button " + cls;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.append(icon(iconName));
      button.onclick = handler;
      this.element.append(button);
      return button;
    };
    const open = (kind) =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "open", action: kind } }),
      );
    this.mcp=document.createElement('button');
    this.mcp.type='button';this.mcp.className='session-mcp quiet-button';this.mcp.textContent='MCP';
    this.mcp.title=WorkbenchI18n.t('Управление MCP для Claude Code');
    this.mcp.setAttribute('aria-label',this.mcp.title);
    this.mcp.onclick=()=>{closeMenus();send('mcpPanel');};
    this.element.append(this.mcp);
    this.bookmarks = action(
      WorkbenchI18n.t("Закладки ответов"),
      "bookmark",
      () => open("bookmarks"),
      "session-bookmarks",
    );
    this.bookmarks.setAttribute("aria-haspopup", "dialog");
    action(
      WorkbenchI18n.t("История сессий"),
      "history",
      () => open("history"),
      "session-history",
    );
    action(
      WorkbenchI18n.t("Новая сессия"),
      "newchat",
      () => {
        closeMenus();
        send("new");
      },
      "new-session",
    );
  }
  closeContext() {}
  update(state) {
    this.state = state;
    this.element.title = state.name || 'Rundix';
    this.mcp.classList.toggle('is-running',!!state.mcpBridgeRunning);
    this.mcp.title=WorkbenchI18n.t('Управление MCP для Claude Code')+' · '+WorkbenchI18n.t(state.mcpBridgeRunning?'Мост запущен':'Мост остановлен');
    this.mcp.setAttribute('aria-label',this.mcp.title);
    this.bookmarks.classList.toggle("has-bookmarks", !!state.bookmarks?.length);
    this.bookmarks.title =
      WorkbenchI18n.t("Закладки ответов") +
      (state.bookmarks?.length ? " · " + state.bookmarks.length : "");
    this.bookmarks.setAttribute("aria-label", this.bookmarks.title);
  }
  startRename(key = this.state.key) {
    if (key !== this.state.key) return;
    this.finishRename(true);
    this.closeMenus();
    const input = document.createElement("input");
    input.className = "session-name-input";
    input.value = this.state.name;
    input.maxLength = 200;
    input.setAttribute("aria-label", WorkbenchI18n.t("Название сессии"));
    this.element.prepend(input);
    this.editing = { key, input, original: this.state.name };
    input.onblur = () => this.finishRename(true);
    input.onkeydown = (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        this.finishRename(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.finishRename(false);
      }
    };
    input.focus();
    input.select();
  }
  finishRename(save) {
    const editing = this.editing;
    if (!editing) return;
    this.editing = null;
    const name = editing.input.value.trim();
    editing.input.onblur = null;
    editing.input.remove();
    if (save && name && name.length <= 200 && name !== editing.original)
      this.send("rename", { name });
  }
}
