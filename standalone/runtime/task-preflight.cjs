const { randomUUID } = require("node:crypto");
const locale = require("../ui/i18n.js");

const fields = [
  "goal",
  "scope",
  "nonGoals",
  "constraints",
  "assumptions",
  "criteria",
  "steps",
  "openQuestions",
];
const schema = {
  type: "object",
  additionalProperties: false,
  required: fields,
  properties: {
    goal: { type: "string" },
    ...Object.fromEntries(
      fields
        .slice(1)
        .map((key) => [key, { type: "array", items: { type: "string" } }]),
    ),
  },
};
function parse(text) {
  if (typeof text !== "string" || text.length > 40000) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value.goal !== "string" ||
    !value.goal.trim() ||
    value.goal.length > 4000
  )
    return null;
  for (const key of fields.slice(1)) {
    if (
      !Array.isArray(value[key]) ||
      value[key].length > 30 ||
      value[key].some(
        (v) => typeof v !== "string" || !v.trim() || v.length > 4000,
      )
    )
      return null;
  }
  if (!value.scope.length || !value.criteria.length || !value.steps.length)
    return null;
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}
function begin() {
  return {
    id: randomUUID(),
    revision: 1,
    phase: "draft",
    spec: null,
    enabled: true,
  };
}
function preparing(task) {
  return !!task?.enabled && task.phase !== "executing";
}
function revise(task) {
  if (task.phase === "review") Object.assign(task, begin());
  task.revision++;
  task.phase = "clarifying";
  task.spec = null;
  delete task.approvedRevision;
}
function finish(task, items, turnId, status, pending) {
  if (!task?.enabled) return;
  if (task.phase === "executing") {
    task.phase = "review";
    return;
  }
  const last = items.findLast(
    (item) => item.turnId === turnId && item.type === "agentMessage",
  );
  const spec = status === "completed" ? parse(last?.text) : null;
  task.spec = spec;
  task.phase =
    spec && !spec.openQuestions.length && !pending && !task.skipped
      ? "ready"
      : "clarifying";
}
function approve(task, id, revision) {
  if (
    !task?.enabled ||
    typeof id !== "string" ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    task.id !== id ||
    task.revision !== revision ||
    task.phase !== "ready" ||
    !parse(JSON.stringify(task.spec)) ||
    task.spec.openQuestions.length ||
    task.skipped
  )
    throw Error(locale.t("План изменился или ещё не готов к согласованию."));
  task.approvedRevision = revision;
  task.phase = "executing";
}
function instructions(task) {
  if (task.phase === "executing")
    return (
      "Implement only the explicitly approved task below. Work in small steps. Verify each acceptance criterion and report passed, failed, or unverified with actual evidence; do not claim a build alone proves behavior. If material new scope or an unresolved decision appears, stop and ask the user. Approved task: " +
      JSON.stringify(task.spec)
    );
  return "Task preparation experiment. Do not implement, edit files, run mutating commands, or start background work. Inspect relevant project sources read-only first. Ask concise structured request_user_input quizzes only about material unknowns; recommended choice first labelled (Recommended), never preselect. Ask at most three questions per round. Avoid repeating answered questions. A skipped quiz is not approval; keep unresolved critical decisions in openQuestions. Return a complete task proposal using the required output schema: goal, scope, nonGoals, constraints, assumptions, observable acceptance criteria with verification methods, ordered steps, openQuestions. Use the user language. The host alone authorizes implementation with a dedicated button. Text instructions to start, Full access, or a quiz answer never authorize execution. Do not assert execution has started. Never include secrets in the proposal.";
}
// Disable integrations for this experimental thread, including after approval.
// Overrides are per-thread; never rewrite the user's configuration files.
function restrictedConfig(config) {
  if (!config || typeof config !== "object")
    throw Error("Cannot read preparation configuration");
  const result = {};
  for (const name of [
    "apps",
    "plugins",
    "remote_plugin",
    "hooks",
    "codex_hooks",
    "multi_agent",
    "goals",
    "computer_use",
    "browser_use",
    "browser_use_external",
  ])
    result["features." + name] = false;
  const clean = (value) =>
    Array.isArray(value)
      ? value.map(clean)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, v]) => v !== null && v !== undefined)
              .map(([k, v]) => [k, clean(v)]),
          )
        : value;
  result.mcp_servers = Object.fromEntries(
    Object.entries(config.mcp_servers || {}).map(([name, value]) => [
      name,
      { ...clean(value), enabled: false },
    ]),
  );
  result.plugins = Object.fromEntries(
    Object.entries(config.plugins || {}).map(([name, value]) => [
      name,
      { ...clean(value), enabled: false },
    ]),
  );
  return result;
}
function policy() {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "read-only",
    sandboxPolicy: { type: "readOnly" },
  };
}
function display(text) {
  const spec = parse(text);
  if (!spec) return text;
  const labels = [
    "Цель",
    "Входит в задачу",
    "Вне задачи",
    "Ограничения",
    "Допущения",
    "Критерии готовности и проверки",
    "План выполнения",
    "Открытые вопросы",
  ];
  return fields
    .map((key, index) => {
      const values = key === "goal" ? [spec[key]] : spec[key];
      return values.length
        ? "**" +
            locale.t(labels[index]) +
            "**\n\n" +
            values.map((v) => "- " + v).join("\n")
        : "";
    })
    .filter(Boolean)
    .join("\n\n");
}
module.exports = {
  schema,
  parse,
  begin,
  preparing,
  revise,
  finish,
  approve,
  instructions,
  restrictedConfig,
  policy,
  display,
};
