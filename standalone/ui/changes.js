(function (root) {
  function stats(diff) {
    let added = 0,
      removed = 0,
      oldLeft = 0,
      newLeft = 0;
    for (const line of String(diff || "").split(/\r?\n/)) {
      const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
        continue;
      }
      if (!oldLeft && !newLeft) continue;
      if (line.startsWith("+")) {
        added++;
        newLeft--;
      } else if (line.startsWith("-")) {
        removed++;
        oldLeft--;
      } else if (line.startsWith(" ")) {
        oldLeft--;
        newLeft--;
      }
    }
    return { added, removed };
  }
  function parts(file, cwd) {
    let value = String(file || "").replace(/\\/g, "/"),
      base = String(cwd || "")
        .replace(/\\/g, "/")
        .replace(/\/$/, "");
    if (base && value.toLowerCase().startsWith(base.toLowerCase() + "/"))
      value = value.slice(base.length + 1);
    const index = value.lastIndexOf("/");
    return {
      name: value.slice(index + 1),
      directory: index < 0 ? "" : value.slice(0, index),
      path: value,
    };
  }
  function card(change, { cwd, icon, open }) {
    const row = document.createElement("button");
    row.className = "changed-file";
    row.type = "button";
    row.title = change.path;
    row.onclick = open;
    row.append(icon("file"));
    const path = parts(change.path, cwd),
      label = document.createElement("span");
    label.className = "changed-file-path";
    const name = document.createElement("strong");
    name.textContent = path.name;
    const directory = document.createElement("small");
    directory.textContent = path.directory;
    label.append(name, directory);
    row.append(label);
    const counts = stats(change.diff);
    for (const [className, text] of [
      ["diff-added", "+" + counts.added],
      ["diff-removed", "−" + counts.removed],
    ]) {
      const span = document.createElement("span");
      span.className = className;
      span.textContent = text;
      row.append(span);
    }
    return row;
  }
  function block(change, options) {
    const wrapper = document.createElement("div");
    wrapper.className = "file-change-block";
    wrapper.append(card(change, options));
    if (!change.diff) return wrapper;
    const details = document.createElement("details");
    details.className = "inline-diff";
    const summary = document.createElement("summary");
    summary.textContent = WorkbenchI18n.t("Показать diff");
    details.append(summary);
    const pre = document.createElement("pre");
    let oldLine = 0,
      newLine = 0,
      inHunk = false;
    const lines = String(change.diff).split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    for (const line of lines) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
      }
      const type =
        inHunk && !hunk
          ? line.startsWith("+")
            ? "added"
            : line.startsWith("-")
              ? "removed"
              : line.startsWith(" ")
                ? "context"
                : "meta"
          : "meta";
      const row = document.createElement("span");
      row.className = "diff-line diff-line-" + type;
      const before = document.createElement("span"),
        after = document.createElement("span"),
        text = document.createElement("span");
      before.className = after.className = "diff-line-number";
      before.textContent = ["removed", "context"].includes(type)
        ? String(oldLine++)
        : "";
      after.textContent = ["added", "context"].includes(type)
        ? String(newLine++)
        : "";
      text.textContent = line;
      row.append(before, after, text);
      pre.append(row);
    }
    details.append(pre);
    wrapper.append(details);
    return wrapper;
  }
  const api = { stats, parts, card, block };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WorkbenchChanges = api;
})(globalThis);
