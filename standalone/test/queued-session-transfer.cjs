const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { SessionStore } = require("../runtime/store.cjs");
const {
  transferQueuedSession,
  acquireQueuedSession,
} = require("../runtime/queued-session-transfer.cjs");

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-queue-transfer-"),
  );
  const store = new SessionStore(directory),
    starts = [],
    opened = [];
  const item = {
    id: "task",
    text: "Unrelated task",
    attachments: [{ id: "image", kind: "image", path: "synthetic/image.png" }],
    modelSelection: { model: "queued-model", effort: "high", fast: true },
  };
  const source = {
    key: "source",
    cwd: directory,
    model: "later-model",
    effort: "low",
    prefs: { mode: "full", access: "full", ide: true },
    draft: "Independent draft",
    attachments: [
      { id: "composer-file", kind: "file", path: "synthetic/file.js" },
    ],
    items: [{ id: "old-history" }],
    busy: true,
    followUps: [item],
    queuePaused: true,
  };
  source.persistedRecord = store.saveSession({
    ...source,
    persistedRecord: undefined,
  });
  const deps = {
    acquire: (key) => store.acquire(key),
    latest: () => store.session(source.key),
    destination: (key) => store.session(key),
    writeDestination: (record) => store.saveSession(record),
    save: async (session) => {
      session.persistedRecord = store.saveSession(
        { key: session.key, followUps: session.followUps },
        session.persistedRecord,
      );
    },
    diagnostic: () => {},
    publish: () => {},
    resume: () => {},
    open: (record) => {
      opened.push(record);
      return record;
    },
    start: async (record) => {
      starts.push(record);
    },
  };
  const message = {
    id: item.id,
    expectedText: item.text,
    expectedAttachmentIds: ["image"],
  };
  return { source, store, deps, message, starts, opened, directory };
}

(async () => {
  const fixtures = [];
  try {
    const f = fixture();
    fixtures.push(f);
    const outer = acquireQueuedSession(f.source, (key) => f.store.acquire(key));
    const inner = acquireQueuedSession(f.source, (key) => f.store.acquire(key));
    f.store.assertNoActiveTurns();
    const turn = f.store.acquire("synthetic-active-turn");
    assert.throws(() => f.store.assertNoActiveTurns());
    turn();
    inner();
    inner();
    outer();
    outer();
    const destination = await transferQueuedSession(
      f.source,
      f.message,
      f.deps,
    );
    assert.equal(f.source.followUps.length, 0);
    assert.equal(f.store.session("source").followUps.length, 0);
    assert.equal(destination.draft, "Unrelated task");
    assert.equal(destination.model, "queued-model");
    assert.equal(destination.effort, "high");
    assert.equal(destination.prefs.fast, true);
    assert.equal(destination.prefs.mode, "full");
    assert.equal(destination.cwd, f.directory);
    assert.deepEqual(destination.items, []);
    assert.deepEqual(destination.followUps, []);
    assert.equal(destination.id, null);
    assert.equal(destination.attachments[0].path, "synthetic/image.png");
    assert.equal(destination.queuePaused, false);
    assert.equal(f.source.draft, "Independent draft");
    assert.equal(f.source.attachments[0].id, "composer-file");
    assert.equal(f.source.busy, true);
    assert.equal(f.starts.length, 1);
    assert.ok(f.store.session(destination.key));
    await assert.rejects(transferQueuedSession(f.source, f.message, f.deps));
    assert.equal(f.starts.length, 1);

    for (const invalid of [
      "uncertain",
      "structured",
      "sending",
      "stale",
      "changed-attachments",
    ]) {
      const x = fixture();
      fixtures.push(x);
      if (invalid === "uncertain")
        x.source.followUps[0].deliveryUncertain = true;
      if (invalid === "structured") {
        x.source.followUps[0].text =
          require("../runtime/async-questions.cjs").buildReply(
            {
              id: "synthetic-quiz",
              type: "agentMessage",
              questions: [{ title: "Synthetic choice" }],
            },
            { 0: "Answer" },
          );
        x.message.expectedText = x.source.followUps[0].text;
        x.source.persistedRecord = x.store.saveSession(
          { key: "source", followUps: x.source.followUps },
          x.source.persistedRecord,
        );
      }
      if (invalid === "sending") x.source.followUpSending = true;
      if (invalid === "stale")
        x.store.saveSession({ key: "source", followUps: [] });
      if (invalid === "changed-attachments")
        x.message.expectedAttachmentIds = [];
      await assert.rejects(
        transferQueuedSession(x.source, x.message, x.deps),
        invalid,
      );
      assert.equal(x.starts.length, 0);
    }
    const before = fixture();
    fixtures.push(before);
    before.deps.save = async () => {
      throw Error("Synthetic disk failure");
    };
    await assert.rejects(
      transferQueuedSession(before.source, before.message, before.deps),
    );
    assert.equal(before.source.followUps[0].deliveryUncertain, undefined);
    assert.equal(before.store.list().length, 1);

    for (const stage of [
      "destination",
      "open-panel",
      "release-source",
      "secondary-state",
    ]) {
      const x = fixture();
      fixtures.push(x);
      const save = x.deps.save,
        write = x.deps.writeDestination;
      let writes = 0;
      x.deps.save = async (session) => {
        writes++;
        if (stage === "release-source" && writes === 2)
          throw Error("Synthetic source release failure");
        await save(session);
        if (stage === "secondary-state")
          throw Error("Synthetic secondary state failure");
      };
      if (stage === "destination")
        x.deps.writeDestination = () => {
          throw Error("Synthetic destination write failure");
        };
      const open = x.deps.open;
      if (stage === "open-panel")
        x.deps.open = () => {
          throw Error("Synthetic panel failure");
        };
      if (stage === "secondary-state") {
        await transferQueuedSession(x.source, x.message, x.deps);
        assert.equal(x.starts.length, 1);
        continue;
      }
      await assert.rejects(transferQueuedSession(x.source, x.message, x.deps));
      assert.equal(x.source.followUps[0].deliveryUncertain, true);
      assert.ok(x.source.followUps[0].transferToSession);
      assert.equal(x.starts.length, 0);
      assert.equal(x.source.queueMutation, false);
      const restored = {
        ...x.source,
        followUps: x.store.session("source").followUps,
        persistedRecord: x.store.session("source"),
      };
      x.source = restored;
      x.deps.latest = () => x.store.session("source");
      x.deps.save = save;
      x.deps.writeDestination = write;
      x.deps.open = open;
      const recovered = await transferQueuedSession(
        restored,
        x.message,
        x.deps,
      );
      assert.equal(restored.followUps.length, 0);
      assert.ok(x.store.session(recovered.key));
      assert.equal(
        x.starts.length,
        0,
        "Recovery must only open the saved task, never automatically replay it",
      );
    }
    const held = fixture();
    fixtures.push(held);
    const otherWindow = structuredClone(held.source);
    let release;
    const save = held.deps.save;
    held.deps.save = async (session) => {
      await save(session);
      await new Promise((resolve) => {
        release = resolve;
      });
    };
    const pending = transferQueuedSession(held.source, held.message, held.deps);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      transferQueuedSession(held.source, held.message, held.deps),
    );
    let concurrentReads = 0;
    const otherDeps = {
      ...held.deps,
      latest: () => {
        concurrentReads++;
        return held.store.session("source");
      },
    };
    await assert.rejects(
      transferQueuedSession(otherWindow, held.message, otherDeps),
    );
    assert.equal(
      concurrentReads,
      0,
      "Another window must acquire ownership before reading/validating the queue",
    );
    held.deps.save = save;
    release();
    await pending;
    assert.equal(held.starts.length, 1);
    await assert.rejects(
      transferQueuedSession(otherWindow, held.message, otherDeps),
    );
    assert.equal(
      held.starts.length,
      1,
      "A stale second window cannot create another destination",
    );
    console.log(
      "PASS: queued task transfer preserves data/settings, reserves ownership durably, rejects stale/uncertain tasks and recovers failed writes without replay.",
    );
  } finally {
    const temp = path.resolve(os.tmpdir());
    for (const f of fixtures) {
      const target = path.resolve(f.directory);
      assert.ok(
        target.startsWith(temp + path.sep) &&
          path.basename(target).startsWith("codex-queue-transfer-"),
      );
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
