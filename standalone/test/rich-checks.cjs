const assert = require("node:assert/strict");
const path = require("node:path");
const markdown = require("../ui/markdown.js");
const { reference } = require("../runtime/references.cjs");
const { copyText, itemText } = require("../runtime/session.cjs");
const { normalize } = require("../ui/limits.js");
const {tabTitle}=require('../runtime/titles.cjs');
assert.equal(tabTitle('Short session'),'Short session');
assert.equal(tabTitle('A'.repeat(18)),'A'.repeat(18));
assert.equal(tabTitle('A'.repeat(200)),'A'.repeat(200));
assert.equal(tabTitle('👩‍💻'.repeat(19)),'👩‍💻'.repeat(19));
assert.equal(tabTitle('  A\n  title  '),'A title');

const text =
  "# Result\n\n**Changed** and `code`.\n\n- parent\n  - child\n\n| File | Status |\n| --- | --- |\n| a.js | done |\n\n~~~js\nconst x = 1;\n~~~\n\n    indented\n\n[src](src/a.js#L12)\n\n<script>alert(1)</script>";
const items = [{ id: "rich", type: "agentMessage", text }];
assert.equal(copyText(items, "rich", 0), "const x = 1;\n");
assert.equal(copyText(items, "rich", 1), "indented\n");
const tokens = markdown.parse(text);
assert.ok(tokens.some((token) => token.type === "table_open"));
assert.equal(
  tokens.filter((token) => token.type === "bullet_list_open").length,
  2,
);
assert.ok(!tokens.some((token) => token.type === "html_block"));
assert.match(
  markdown.highlighted("const x = 1;", "javascript"),
  /hljs-keyword/,
);
const cwd = path.resolve("fixture");
assert.deepEqual(reference(items, "rich", "src/a.js#L12", cwd), {
  path: path.join(cwd, "src/a.js"),
  line: 12,
});
assert.throws(() => reference(items, "rich", "src/injected.js", cwd));
assert.throws(() =>
  reference(
    [{ id: "x", type: "agentMessage", text: "[escape](../private.txt)" }],
    "x",
    "../private.txt",
    cwd,
  ),
);
assert.equal(
  itemText({
    type: "mcpToolCall",
    tool: "read",
    result: { content: { invalid: true } },
  }),
  "read\n\n{}",
);
assert.deepEqual(
  normalize({
    rateLimits: {
      primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 123 },
      secondary: { usedPercent: 8, windowDurationMins: 10080 },
    },
  })[0].windows.map((w) => w.remaining),
  [65, 92],
);
assert.equal(
  normalize({ rateLimits: { primary: { usedPercent: 140 } } })[0].windows[0]
    .remaining,
  0,
);
assert.equal(
  normalize({ rateLimits: { primary: { usedPercent: -1 } } })[0].windows[0]
    .remaining,
  100,
);
assert.deepEqual(
  normalize({ rateLimits: { primary: { usedPercent: null } } })[0].windows,
  [],
);
assert.equal(
  normalize({
    rateLimits: { limitId: "old" },
    rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 1 } },
      other: { secondary: { usedPercent: 2 } },
    },
  }).length,
  2,
);
assert.deepEqual(normalize(null), []);
console.log(
  "PASS: Markdown blocks, syntax, code copying, validated file links, malformed tools, official rate-limit windows and multiple buckets.",
);
