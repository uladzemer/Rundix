const fs = require("node:fs");
const path = require("node:path");
const icons = {};
const iconDirectory = path.join(__dirname, "resources/icons");
for (const file of fs
  .readdirSync(iconDirectory)
  .filter((name) => name.endsWith(".svg"))) {
  const svg = fs
    .readFileSync(path.join(iconDirectory, file), "utf8")
    .replace(/#0D0D0D/gi, "currentColor");
  const attributes = (value) =>
    Object.fromEntries(
      [...value.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [
        match[1],
        match[2],
      ]),
    );
  icons[path.basename(file, ".svg")] = {
    root: attributes(svg.match(/<svg\b([^>]*)>/)[1]),
    paths: [...svg.matchAll(/<path\b([^>]*)\/?\s*>/g)].map((match) =>
      attributes(match[1]),
    ),
  };
}
fs.writeFileSync(
  path.join(__dirname, "ui/icons.js"),
  "// SVG geometry from local icon sources. See resources/icons/NOTICE.md.\nglobalThis.WorkbenchIcons=" +
    JSON.stringify(icons) +
    ";\n",
);
require("esbuild").buildSync({
  entryPoints: [path.join(__dirname, "runtime/markdown-source.cjs")],
  outfile: path.join(__dirname, "ui/markdown.js"),
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  globalName: "WorkbenchMarkdown",
  legalComments: "eof",
  footer: {
    js: "if(typeof module!=='undefined'&&module.exports)module.exports=WorkbenchMarkdown;",
  },
});
require('esbuild').buildSync({
  entryPoints:[path.join(__dirname,'runtime/archive-source.cjs')],
  outfile:path.join(__dirname,'runtime/archive.cjs'),bundle:true,minify:true,
  platform:'node',format:'cjs',legalComments:'eof',
});
let notices = "Third-party libraries included in ui/markdown.js and runtime/archive.cjs\n\n";
for (const name of [
  "markdown-it",
  "highlight.js",
  "argparse",
  "entities",
  "linkify-it",
  "mdurl",
  "punycode.js",
  "uc.micro",
  "tar", "@isaacs/fs-minipass", "minipass", "minizlib", "chownr", "yallist",
]) {
  const dir = path.join(__dirname, "node_modules", name);
  const license = fs
    .readdirSync(dir)
    .find((file) => /^LICENSE(?:[.-]|$)/i.test(file));
  notices +=
    "\n" +
    name +
    "\n" +
    fs.readFileSync(path.join(dir, license), "utf8") +
    "\n";
}
fs.writeFileSync(path.join(__dirname, "THIRD_PARTY_NOTICES.txt"), notices);
