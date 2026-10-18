const path = require("node:path");
const { parse } = require("../ui/markdown.js");
function reference(items, itemId, href, cwd) {
  const item = items.find(
    (item) => item.id === itemId && item.type === "agentMessage",
  );
  if (!item || typeof href !== "string" || href.length > 10000)
    throw Error("Reference not found.");
  const links = [];
  const walk = (tokens) => {
    for (const token of tokens) {
      if (token.type === "link_open") links.push(token.attrGet("href"));
      if (token.children) walk(token.children);
    }
  };
  walk(parse(item.text));
  if (!links.includes(href)) throw Error("Reference not found.");
  if (/^https?:\/\//i.test(href)) {
    const url = new URL(href);
    if (url.username || url.password) throw Error("Unsupported URL.");
    return { url: url.href };
  }
  if (
    !cwd ||
    /^(?:[a-z][a-z\d+.-]*:)(?![\\/])/i.test(href) ||
    href.startsWith("//")
  )
    throw Error("Unsupported reference.");
  let file = decodeURIComponent(href);
  if (/^\/[a-z]:[\\/]/i.test(file)) file = file.slice(1);
  let line = 1;
  const suffix = file.match(/(?:#L|:)(\d+)(?::\d+)?$/);
  if (suffix) {
    line = Math.max(1, Number(suffix[1]));
    file = file.slice(0, -suffix[0].length);
  }
  const absolute = path.resolve(cwd, file),
    relative = path.relative(path.resolve(cwd), absolute);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    throw Error("The reference is outside this project.");
  return { path: absolute, line };
}
module.exports = { reference };
