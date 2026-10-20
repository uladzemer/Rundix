const assert = require("node:assert/strict");

module.exports = async ({ api, starts, turns }) => {
  const source = api.create();
  source.model = "fixture";
  source.effort = "high";
  source.busy = true;
  source.prefs = { ...source.prefs, mode: "full", access: "full", ide: false };
  source.attachments = [
    {
      id: "transfer-image",
      kind: "image",
      path: "synthetic/transfer.png",
      name: "transfer.png",
    },
  ];
  await api.handle(source, {
    action: "send",
    text: "Synthetic unrelated queued task",
  });
  const item = source.followUps[0],
    message = {
      action: "transferQueued",
      id: item.id,
      expectedText: item.text,
      expectedAttachmentIds: ["transfer-image"],
    };
  source.attachments = [
    { id: "independent", kind: "file", path: "synthetic/independent.js" },
  ];
  await api.handle(source, {
    action: "draft",
    text: "Independent composer draft",
  });
  const before = starts.length;
  const destination = await api.handle(source, message);
  assert.notEqual(destination.key, source.key);
  assert.notEqual(api.view(destination).host, api.view(source).host);
  assert.equal(starts.length, before + 1);
  assert.equal(source.busy, true);
  assert.equal(source.followUps.length, 0);
  assert.equal(source.draft, "Independent composer draft");
  assert.equal(source.attachments[0].id, "independent");
  assert.equal(destination.cwd, source.cwd);
  assert.deepEqual(destination.items, []);
  assert.deepEqual(destination.followUps, []);
  assert.equal(destination.draft, "");
  assert.equal(destination.busy, true);
  assert.equal(destination.prefs.mode, "full");
  assert.equal(turns.at(-1).input[0].text, item.text);
  assert.equal(turns.at(-1).input[1].path, "synthetic/transfer.png");
  assert.equal(turns.at(-1).model, "fixture");
  assert.equal(turns.at(-1).effort, "high");
  assert.equal(turns.at(-1).sandboxPolicy.type, "dangerFullAccess");
  assert.equal(api.store.session(source.key).followUps.length, 0);
  await assert.rejects(api.handle(source, message));
  assert.equal(starts.length, before + 1);

  await api.handle(source, {
    action: "send",
    text: "Synthetic failed destination request",
  });
  const pending = source.followUps[0],
    server = api.server(),
    request = server.request;
  let attempts = 0;
  server.request = function (method, params) {
    if (method === "turn/start") {
      attempts++;
      throw Error("Synthetic lost turn response");
    }
    return request.call(this, method, params);
  };
  let failed;
  try {
    failed = await api.handle(source, {
      action: "transferQueued",
      id: pending.id,
      expectedText: pending.text,
      expectedAttachmentIds: pending.attachments.map((file) => file.id),
    });
  } finally {
    server.request = request;
  }
  assert.equal(attempts, 1);
  assert.equal(source.followUps.length, 0);
  assert.equal(failed.draft, pending.text);
  assert.equal(failed.error, "Synthetic lost turn response");
  assert.equal(api.store.session(failed.key).draft, pending.text);

  await api.handle(source, {
    action: "send",
    text: "Synthetic competing queue drain",
  });
  const task = source.followUps[0],
    otherWindow = {
      ...source,
      busy: false,
      followUps: structuredClone(source.followUps),
      persistedRecord: structuredClone(source.persistedRecord),
    };
  const update = api.library.storage.update;
  let release,
    held = false,
    timer;
  api.library.storage.update = function (key, value) {
    if (key !== "session:" + source.key || held)
      return update.call(this, key, value);
    held = true;
    return new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(Error("Synthetic transfer hold timed out")),
        5000,
      );
      release = () => {
        clearTimeout(timer);
        update.call(this, key, value).then(resolve, reject);
      };
    });
  };
  try {
    const moving = api.handle(source, {
      action: "transferQueued",
      id: task.id,
      expectedText: task.text,
      expectedAttachmentIds: task.attachments.map((file) => file.id),
    });
    for (let n = 0; n < 100 && !release; n++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(release);
    const requests = turns.length;
    await assert.rejects(api.handle(otherWindow, { action: "sendQueued" }));
    await assert.rejects(
      api.handle(otherWindow, {
        action: "transferQueued",
        id: task.id,
        expectedText: task.text,
        expectedAttachmentIds: task.attachments.map((file) => file.id),
      }),
    );
    assert.equal(turns.length, requests);
    api.library.storage.update = update;
    release();
    await moving;
    assert.equal(turns.length, requests + 1);
  } finally {
    clearTimeout(timer);
    api.library.storage.update = update;
  }

  await api.handle(source, {
    action: "send",
    text: "Synthetic close destination before dispatch",
  });
  const closeTask = source.followUps[0],
    requests = turns.length;
  let saves = 0,
    targetKey;
  api.library.storage.update = function (key, value) {
    if (key === "session:" + source.key) {
      saves++;
      if (saves === 1)
        targetKey = value.followUps.find(
          (item) => item.id === closeTask.id,
        ).transferToSession;
      if (saves === 2) api.view(api.sessions.get(targetKey)).panel.dispose();
    }
    return update.call(this, key, value);
  };
  try {
    const closed = await api.handle(source, {
      action: "transferQueued",
      id: closeTask.id,
      expectedText: closeTask.text,
      expectedAttachmentIds: closeTask.attachments.map((file) => file.id),
    });
    assert.equal(api.view(closed).panel, null);
    assert.equal(closed.draft, closeTask.text);
    assert.equal(turns.length, requests);
    assert.equal(api.store.session(closed.key).draft, closeTask.text);
  } finally {
    api.library.storage.update = update;
  }
};
