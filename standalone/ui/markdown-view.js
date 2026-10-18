// Render parser tokens through DOM APIs. Raw HTML, external images and command URLs are never injected.
class WorkbenchMarkdownView {
  constructor({ icon, send }) {
    this.icon = icon;
    this.send = send;
  }
  formatCompletionReports(root) {
    const layouts = [
      ['Что было задано', 'Что я решил', 'Что бы я ещё сделал'],
      ['Что было задано', 'Что сделано', 'Что не удалось / ограничения', 'Что бы я ещё сделал'],
      ['What was asked', 'What I decided', 'What I would do next'],
      ['What was asked', 'What was done', 'Limitations', 'What I would do next'],
    ];
    const normalize = text => text.trim().replace(/:$/, '').toLocaleLowerCase();
    for (const source of [...root.children]) {
      if (!['UL', 'OL'].includes(source.tagName) || source.tagName === 'OL' && source.start !== 1) continue;
      const rows = [...source.children];
      if (![3, 4].includes(rows.length)) continue;
      const titles = rows.map(row => {
        const paragraph = row.firstElementChild;
        if (paragraph?.tagName !== 'P') return null;
        return [...paragraph.childNodes].find(node => node.nodeType !== 3 || node.textContent.trim());
      });
      if (!titles.every(title => title?.nodeName === 'STRONG')) continue;
      const matches = layouts.some(layout => layout.length === titles.length &&
        layout.every((label, index) => normalize(label) === normalize(titles[index].textContent)));
      if (!matches) continue;
      const list = source.tagName === 'OL' ? source : document.createElement('ol');
      if (list !== source) {
        list.append(...source.childNodes);
        source.replaceWith(list);
      }
      list.classList.add('completion-report');
      for (const title of titles) {
        const following = title.nextSibling;
        if (following?.nodeType === 3 && following.textContent.startsWith(':')) {
          title.append(document.createTextNode(':'));
          following.textContent = following.textContent.slice(1);
        }
        title.classList.add('report-title');
      }
    }
  }
  render(item) {
    const root = document.createElement("div");
    root.className = "message-content";
    const stack = [root];
    let codeIndex = 0;
    const append = (node) => stack.at(-1).append(node);
    const inline = (tokens) => {
      for (const token of tokens || []) {
        if (token.type === "text")
          append(document.createTextNode(token.content));
        else if (token.type === "code_inline") {
          const code = document.createElement("code");
          code.textContent = token.content;
          append(code);
        } else if (token.type === "softbreak")
          append(document.createTextNode("\n"));
        else if (token.type === "hardbreak")
          append(document.createElement("br"));
        else if (token.type === "image") {
          const text = document.createElement("span");
          text.className = "markdown-image-label";
          text.textContent = token.content || WorkbenchI18n.t("Изображение");
          append(text);
        } else if (token.type === "link_open") {
          const href = token.attrGet("href") || "",
            link = document.createElement("a");
          link.textContent = "";
          if (!/^(?:javascript|data|command|vbscript):/i.test(href)) {
            link.href = "#";
            link.title = href;
            link.onclick = (event) => {
              event.preventDefault();
              this.send("openReference", { itemId: item.id, href });
            };
          }
          append(link);
          stack.push(link);
        } else if (token.type === "link_close") stack.pop();
        else if (
          token.nesting === 1 &&
          ["strong", "em", "s"].includes(token.tag)
        ) {
          const node = document.createElement(token.tag);
          append(node);
          stack.push(node);
        } else if (token.nesting === -1) stack.pop();
        else if (token.content) append(document.createTextNode(token.content));
      }
    };
    for (const token of WorkbenchMarkdown.parse(item.text)) {
      if (token.type === "inline") {
        inline(token.children);
        continue;
      }
      if (token.type === "fence" || token.type === "code_block") {
        const wrapper = document.createElement("div");
        wrapper.className = "code-block";
        const bar = document.createElement("div");
        bar.className = "code-header";
        const language = token.info.trim().split(/\s+/)[0] || "";
        const label = document.createElement("span");
        label.textContent = language || WorkbenchI18n.t("Код");
        bar.append(label);
        const index = codeIndex++,
          copy = document.createElement("button");
        copy.type = "button";
        copy.className = "icon-button code-copy";
        copy.dataset.codeIndex = index;
        copy.title = WorkbenchI18n.t("Копировать код");
        copy.setAttribute("aria-label", copy.title);
        copy.append(this.icon("copy"));
        copy.onclick = () =>
          this.send("copyItem", { itemId: item.id, codeIndex: index });
        bar.append(copy);
        const pre = document.createElement("pre");
        pre.className = "code";
        const code = document.createElement("code");
        const highlighted = WorkbenchMarkdown.highlighted(
          token.content,
          language,
        );
        if (highlighted) {
          const parsed = new DOMParser().parseFromString(
            highlighted,
            "text/html",
          );
          const safe = (node, parent) => {
            if (node.nodeType === 3)
              parent.append(document.createTextNode(node.textContent));
            else if (node.nodeName === "SPAN") {
              const span = document.createElement("span");
              span.className = [...node.classList]
                .filter((name) => /^[a-zA-Z_][\w-]*$/.test(name))
                .join(" ");
              parent.append(span);
              for (const child of node.childNodes) safe(child, span);
            }
          };
          for (const child of parsed.body.childNodes) safe(child, code);
        } else code.textContent = token.content;
        pre.append(code);
        wrapper.append(bar, pre);
        append(wrapper);
        continue;
      }
      if (token.type === "hr") {
        append(document.createElement("hr"));
        continue;
      }
      if (
        token.nesting === 1 &&
        [
          "p",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "ul",
          "ol",
          "li",
          "blockquote",
          "table",
          "thead",
          "tbody",
          "tr",
          "th",
          "td",
        ].includes(token.tag)
      ) {
        const node = document.createElement(token.tag);
        if (token.tag === "p") node.className = "message-line";
        if (token.hidden) node.classList.add("tight-paragraph");
        if (token.tag === "ol" && token.attrGet("start"))
          node.start = Number(token.attrGet("start"));
        if (["td", "th"].includes(token.tag)) {
          const align = token
            .attrGet("style")
            ?.match(/^text-align:(left|right|center)$/)?.[1];
          if (align) node.classList.add("align-" + align);
        }
        if (token.tag === "table") {
          const wrapper = document.createElement("div");
          wrapper.className = "markdown-table";
          append(wrapper);
          wrapper.append(node);
        } else append(node);
        stack.push(node);
      } else if (token.nesting === -1 && stack.length > 1) stack.pop();
    }
    for (const paragraph of root.querySelectorAll("li > p:first-child")) {
      const first = paragraph.firstChild;
      if (first?.nodeType !== 3) continue;
      const task = first.textContent.match(/^\[([ xX])\]\s+/);
      if (!task) continue;
      first.textContent = first.textContent.slice(task[0].length);
      const marker = document.createElement("span");
      marker.className = "task-marker";
      marker.setAttribute("role", "checkbox");
      marker.setAttribute("aria-checked", String(task[1] !== " "));
      marker.setAttribute("aria-disabled", "true");
      marker.textContent = task[1] === " " ? "☐" : "☑";
      paragraph.prepend(marker);
      paragraph.closest("li").classList.add("task-item");
    }
    // Only known completion-report layouts change presentation; source text and ordinary lists stay intact.
    if (item.type === 'agentMessage' && item.phase !== 'commentary') this.formatCompletionReports(root);
    return root;
  }
}
