// Synthetic protocol peer for host.cjs. Never starts the CLI or reads an account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AppServer } = require('../runtime/transport.cjs');

module.exports = async (vscode) => {
  const original = { start: AppServer.prototype.start, request: AppServer.prototype.request };
  const config = vscode.workspace.getConfiguration('rundix');
  await config.update('cliPath', process.execPath, vscode.ConfigurationTarget.Global);
  await config.update('cliAutoUpdate', false, vscode.ConfigurationTarget.Global);
  // Deliberately differ in default effort and include Ultra unconditionally.
  const models = ['low', 'medium'].map((effort) => ({
    model: 'synthetic-' + effort, isDefault: effort === 'medium',
    defaultReasoningEffort: effort,
    supportedReasoningEfforts: ['low', 'medium', 'ultra'].map(reasoningEffort => ({ reasoningEffort })),
  }));
  const threads = new Map();
  let sequence = 0;
  const notify = (server, method, params) => server.emit('notification', { method, params });
  const item = (server, thread, turnId, value) => {
    thread.items.push({ turnId, item: value });
    notify(server, 'item/completed', { threadId: thread.id, turnId, item: value });
  };
  AppServer.prototype.start = async function () { return this; };
  AppServer.prototype.request = async function (method, p = {}) {
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' } };
    if (method === 'account/rateLimits/read') return { rateLimits: {} };
    if (method === 'model/list') return { data: structuredClone(models), nextCursor: null };
    if (method === 'config/read') return { config: { model: 'synthetic-medium', model_reasoning_effort: 'medium' } };
    if (method === 'skills/list') return { data: [{ skills: [{ name: 'synthetic-skill', enabled: true,
      path: path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'synthetic-skill', 'SKILL.md') }] }] };
    if (method === 'thread/start' || method === 'thread/fork') {
      const source = method === 'thread/fork' ? threads.get(p.threadId) : null;
      let items = [];
      if (source) {
        const end = source.items.findLastIndex(entry => entry.turnId === p.lastTurnId);
        assert.ok(end >= 0, 'Fork must name an existing synthetic turn');
        items = structuredClone(source.items.slice(0, end + 1));
      }
      const thread = { id: 'synthetic-host-thread-' + ++sequence, cwd: p.cwd, items,
        forkedFromId: source?.id, model: source?.model || p.model,
        reasoningEffort: models.find(m => m.model === (source?.model || p.model)).defaultReasoningEffort };
      threads.set(thread.id, thread);
      return { thread, model: thread.model, reasoningEffort: thread.reasoningEffort };
    }
    if (method === 'thread/list') return { data: [], nextCursor: null };
    const thread = threads.get(p.threadId);
    if (method === 'thread/delete') { threads.delete(p.threadId); return {}; }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    if (method === 'thread/name/set') { thread.name = p.name; return {}; }
    if (method === 'thread/settings/update') {
      Object.assign(thread, {
        model: p.model || thread.model, reasoningEffort: p.effort || thread.reasoningEffort,
        approvalPolicy: p.approvalPolicy || thread.approvalPolicy,
        approvalsReviewer: p.approvalsReviewer || thread.approvalsReviewer,
        sandbox: p.sandboxPolicy || thread.sandbox,
      });
      return {};
    }
    if (method === 'thread/resume') return { thread, model: thread.model, reasoningEffort: thread.reasoningEffort,
      approvalPolicy: thread.approvalPolicy, approvalsReviewer: thread.approvalsReviewer, sandbox: thread.sandbox };
    if (method === 'thread/items/list') return { data: structuredClone(thread.items).reverse(), nextCursor: null };
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (method === 'turn/start' || method === 'thread/compact/start') {
      const turnId = 'synthetic-host-turn-' + ++sequence;
      // Deliver after the RPC response, while the host is displaying another tab.
      setTimeout(() => {
        notify(this, 'turn/started', { threadId: thread.id, turn: { id: turnId } });
        if (method === 'turn/start') {
          item(this, thread, turnId, { id: turnId + '-user', type: 'userMessage', content: p.input });
          const file = path.join(thread.cwd, 'workbench-tool-probe.txt');
          fs.writeFileSync(file, 'WORKBENCH_FILE_OK\n');
          item(this, thread, turnId, { id: turnId + '-file', type: 'fileChange',
            changes: [{ path: file, diff: '+WORKBENCH_FILE_OK\n' }] });
          item(this, thread, turnId, { id: turnId + '-command', type: 'commandExecution',
            command: 'synthetic read', aggregatedOutput: 'WORKBENCH_FILE_OK\n', status: 'completed' });
          item(this, thread, turnId, { id: turnId + '-agent', type: 'agentMessage', text: 'WORKBENCH_HOST_OK' });
          notify(this, 'thread/tokenUsage/updated', { threadId: thread.id,
            tokenUsage: { modelContextWindow: 1000, last: { totalTokens: 20 } } });
        } else item(this, thread, turnId, { id: turnId + '-compact', type: 'contextCompaction' });
        notify(this, 'turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } });
      }, 50);
      return { turn: { id: turnId } };
    }
    throw Error('Unexpected synthetic host RPC: ' + method);
  };
  return () => {
    AppServer.prototype.start = original.start;
    AppServer.prototype.request = original.request;
  };
};
