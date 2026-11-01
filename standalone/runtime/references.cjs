const path = require("node:path");
const { parse } = require("../ui/markdown.js");
function links(items, itemId) {
  const item = items.find(
    (item) => item.id === itemId && item.type === "agentMessage",
  );
  const result = [];
  const walk = (tokens) => {
    for (const token of tokens) {
      if (token.type === "link_open") result.push(token.attrGet("href"));
      if (token.children) walk(token.children);
    }
  };
  if (item) walk(parse(item.text));
  return result;
}
function reference(items, itemId, href, cwd) {
  if (typeof href !== "string" || href.length > 10000)
    throw Error("Reference not found.");
  if (!links(items, itemId).includes(href)) throw Error("Reference not found.");
  if (/^https?:\/\//i.test(href)) {
    const url = new URL(href);
    if (url.username || url.password) throw Error("Unsupported URL.");
    return { url: url.href };
  }
  let file;
  try {
    file = decodeURIComponent(href);
  } catch {
    throw Error("Unsupported reference.");
  }
  // Drive letters (D:\ or D:/) are paths; any other scheme is not a file.
  if (
    !cwd ||
    /^(?:[a-z][a-z\d+.-]*:)(?![\\/])/i.test(file) ||
    /^[\\/]{2}/.test(file)
  )
    throw Error("Unsupported reference.");
  if (/^\/[a-z]:[\\/]/i.test(file)) file = file.slice(1);
  let line = 1;
  // file:12, file:12:3, file:12-20, file#L12, file#L12C3, file#L12-L20
  const suffix = file.match(
    /(?:#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?|:(\d+)(?::\d+)?(?:-\d+)?)$/,
  );
  if (suffix) {
    line = Math.max(1, Number(suffix[1] || suffix[2]));
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
