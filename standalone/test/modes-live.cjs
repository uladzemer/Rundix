require('./test-isolation.cjs').isolate();
// Verify effective settings returned by the installed CLI; no agent turn or tools run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AppServer } = require('../runtime/transport.cjs');
const { modes, policy } = require('../ui/modes.js');

(async () => {
  const server = new AppServer();
  const report = { inferenceRun: false, modes: [], effortSettingsVerified: [] };
  let threadId;
  try {
    await server.start();
    const catalog = await server.request('model/list', { limit: 100 });
    const thread = await server.request('thread/start', {
      cwd: process.cwd(), ephemeral: true, sandbox: 'read-only', approvalPolicy: 'on-request',
    });
    threadId = thread.thread.id;
    async function update(params) {
      let listener, timer;
      const notification = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('No effective settings notification')), 5000);
        listener = event => {
          if (event.method === 'thread/settings/updated' && event.params.threadId === threadId)
            resolve(event.params.threadSettings);
        };
        server.on('notification', listener);
      });
      // Attach a handler immediately in case the RPC fails before the timeout.
      notification.catch(() => {});
      try {
        await server.request('thread/settings/update', { threadId, ...params });
        return await notification;
      } finally { clearTimeout(timer); server.off('notification', listener); }
    }
    for (const mode of modes) {
      const requested = policy(mode.id, process.cwd());
      const actual = await update({
        approvalPolicy: requested.approvalPolicy,
        approvalsReviewer: requested.approvalsReviewer,
        sandboxPolicy: requested.sandboxPolicy,
        collaborationMode: {
          mode: mode.plan ? 'plan' : 'default',
          settings: { model: thread.model, reasoning_effort: thread.reasoningEffort, developer_instructions: null },
        },
      });
      assert.equal(actual.approvalPolicy, requested.approvalPolicy);
      assert.equal(actual.approvalsReviewer, requested.approvalsReviewer);
      assert.equal(actual.sandboxPolicy.type, requested.sandboxPolicy.type);
      assert.equal(actual.collaborationMode.mode, mode.plan ? 'plan' : 'default');
      report.modes.push({ mode: mode.id, approvalPolicy: actual.approvalPolicy,
        reviewer: actual.approvalsReviewer, sandbox: actual.sandboxPolicy.type,
        collaboration: actual.collaborationMode.mode });
    }
    const model = catalog.data.find(model => model.model === thread.model);
    assert.ok(model);
    for (const option of model.supportedReasoningEfforts) {
      const actual = await update({ effort: option.reasoningEffort });
      assert.equal(actual.effort, option.reasoningEffort);
      report.effortSettingsVerified.push(actual.effort);
    }
    report.passed = true;
  } finally {
    if (threadId) await server.request('thread/delete', { threadId }).catch(() => {});
    server.dispose();
  }
  const directory = path.join(__dirname, '../.verification');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'modes-audit.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
