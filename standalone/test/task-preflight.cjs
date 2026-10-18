const assert = require("node:assert/strict");
const p = require("../runtime/task-preflight.cjs");
const spec = {
  goal: "Synthetic task",
  scope: ["Behavior"],
  nonGoals: [],
  constraints: [],
  assumptions: [],
  criteria: ["Observe expected result"],
  steps: ["Implement", "Verify"],
  openQuestions: [],
};
const task = p.begin();
p.revise(task);
const items = [
  { type: "agentMessage", turnId: "turn1", text: JSON.stringify(spec) },
];
for (const text of [
  "",
  JSON.stringify({ ...spec, criteria: [] }),
  JSON.stringify({ ...spec, steps: [42] }),
  "null",
])
  assert.equal(p.parse(text), null);
assert.deepEqual(p.parse(JSON.stringify(spec)), spec);
p.finish(task, items, "turn1", "completed", true);
assert.equal(task.phase, "clarifying");
task.skipped = true;
p.finish(task, items, "turn1", "completed", false);
assert.equal(task.phase, "clarifying");
assert.throws(() => p.approve(task, task.id, task.revision));
task.skipped = false;
p.finish(task, items, "turn1", "completed", false);
assert.equal(task.phase, "ready");
assert.throws(() => p.approve(task, task.id, task.revision - 1));
const restored = JSON.parse(JSON.stringify(task));
p.approve(restored, task.id, task.revision);
assert.equal(p.preparing(restored), false);
assert.throws(() => p.approve(restored, task.id, task.revision));
p.finish(restored, [], "run", "completed", false);
assert.equal(restored.phase, "review");
p.revise(restored);
assert.notEqual(restored.id, task.id);
assert.equal(p.preparing(restored), true);
p.finish(task, items, "another", "completed", false);
assert.equal(task.phase, "clarifying");
p.finish(task, items, "turn1", "interrupted", false);
assert.equal(task.phase, "clarifying");
const cfg = p.restrictedConfig({
  mcp_servers: {
    "name.with.dot": { command: "synthetic", tool_timeout_sec: null },
  },
  plugins: { "fixture@synthetic": { enabled: true } },
});
assert.equal(cfg.mcp_servers["name.with.dot"].enabled, false);
assert.equal(cfg.mcp_servers["name.with.dot"].tool_timeout_sec, undefined);
assert.equal(cfg["features.apps"], false);
assert.equal(cfg["features.hooks"], false);
assert.equal(cfg.plugins["fixture@synthetic"].enabled, false);
assert.equal(p.policy().approvalPolicy, "never");
assert.equal(p.policy().sandboxPolicy.type, "readOnly");
console.log(
  "Task preparation transitions, stale approval, skips, malformed output and configuration passed",
);
