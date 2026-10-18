const assert = require("node:assert/strict");
module.exports = async ({ api, s, counts, turnSettings }) => {
  s.id = null;
  s.loaded = false;
  s.items = [];
  s.followUps = [];
  s.attachments = [];
  s.asyncQuestionReplies = {};
  s.questionHistory = [];
  s.model = "fixture";
  s.effort = "medium";
  await api.handle(s, { action: "preflight", enabled: true });
  await api.handle(s, { action: "mode", mode: "full" });
  // Use the stored preference just as an existing Full access session would.
  s.prefs = { ...s.prefs, mode: "full", access: "full", plan: false };
  await api.handle(s, { action: "send", text: "Synthetic complex task" });
  assert.equal(turnSettings.at(-1).sandboxPolicy.type, "readOnly");
  assert.equal(turnSettings.at(-1).approvalPolicy, "never");
  assert.ok(turnSettings.at(-1).outputSchema);
  await assert.rejects(api.handle(s, { action: "preflight", enabled: false }));
  const spec = {
    goal: "Synthetic goal",
    scope: ["Change fixture"],
    nonGoals: [],
    constraints: [],
    assumptions: [],
    criteria: ["Verify fixture"],
    steps: ["Change", "Verify"],
    openQuestions: [],
  };
  const finish = () => {
    api
      .server()
      .emit("notification", {
        method: "item/completed",
        params: {
          threadId: s.id,
          turnId: s.turnId,
          item: {
            id: "proposal-" + s.preflight.revision,
            type: "agentMessage",
            text: JSON.stringify(spec),
          },
        },
      });
    api
      .server()
      .emit("notification", {
        method: "turn/completed",
        params: { threadId: s.id, turn: { id: s.turnId, status: "completed" } },
      });
  };
  finish();
  assert.equal(s.preflight.phase, "ready");
  const revision = s.preflight.revision;
  const before = counts["turn/start"];
  await assert.rejects(
    api.handle(s, {
      action: "approveTask",
      id: s.preflight.id,
      revision: revision - 1,
    }),
  );
  assert.equal(counts["turn/start"], before);
  assert.equal(s.preflight.phase, "ready");
  // Restore persisted task state; approval must still be an explicit action.
  s.preflight = JSON.parse(JSON.stringify(api.store.session(s.key).preflight));
  await api.handle(s, { action: "send", text: "Refine acceptance criterion" });
  assert.equal(turnSettings.at(-1).sandboxPolicy.type, "readOnly");
  api
    .server()
    .emit("notification", {
      method: "turn/completed",
      params: {
        threadId: s.id,
        turn: { id: "stale-turn", status: "completed" },
      },
    });
  assert.equal(s.busy, true);
  assert.equal(s.preflight.phase, "clarifying");
  finish();
  assert.equal(s.preflight.phase, "ready");
  assert.ok(s.preflight.revision > revision);
  await api.handle(s, {
    action: "approveTask",
    id: s.preflight.id,
    revision: s.preflight.revision,
  });
  assert.equal(turnSettings.at(-1).sandboxPolicy.type, "dangerFullAccess");
  assert.equal(turnSettings.at(-1).outputSchema, undefined);
  assert.equal(s.preflight.phase, "executing");
  await assert.rejects(
    api.handle(s, {
      action: "approveTask",
      id: s.preflight.id,
      revision: s.preflight.revision,
    }),
  );
  // Queued work cannot inherit approval for the preceding task.
  const taskId = s.preflight.id;
  await api.handle(s, { action: "send", text: "Next complex task" });
  api
    .server()
    .emit("notification", {
      method: "turn/completed",
      params: { threadId: s.id, turn: { id: s.turnId, status: "completed" } },
    });
  for (let n = 0; n < 200 && (s.followUpSending || s.followUps.length); n++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(s.followUps.length, 0);
  assert.notEqual(s.preflight.id, taskId);
  assert.equal(turnSettings.at(-1).sandboxPolicy.type, "readOnly");
  s.preflight.skipped = true;
  finish();
  assert.equal(s.preflight.phase, "clarifying");
  await assert.rejects(
    api.handle(s, {
      action: "approveTask",
      id: s.preflight.id,
      revision: s.preflight.revision,
    }),
  );
};
