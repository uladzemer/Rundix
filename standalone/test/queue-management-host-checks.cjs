const assert = require('node:assert/strict');

module.exports = async ({ api, s, counts, inputs }) => {
  s.preflight = null;s.busy = true;s.stopRequested = false;s.model = 'fixture';s.effort = 'medium';
  await api.handle(s, { action: 'queuePause', paused: true });
  s.attachments = [{ id: 'queue-original-file', kind: 'file', name: 'original.js', path: 'synthetic/original.js' }];
  await api.handle(s, { action: 'send', text: 'Managed A' });
  await api.handle(s, { action: 'send', text: 'Managed B' });
  await api.handle(s, { action: 'send', text: 'Managed C' });
  const [a, b, c] = s.followUps;
  // Editing/reordering a queue halted by an earlier error must not restart it.
  s.busy = false;s.queuePaused = false;s.lastTurnStatus = 'completed';
  await api.handle(s, { action: 'preferences', focus: false });
  const haltedStarts = counts['turn/start'];s.error = 'Synthetic halted queue';
  await api.handle(s, { action: 'editQueued', id: a.id, expectedText: a.text, text: a.text, requestId: 'synthetic-no-restart' });
  await api.handle(s, { action: 'moveQueued', id: b.id, direction: -1, expectedOrder: s.followUps.map(item => item.id) });
  await api.handle(s, { action: 'moveQueued', id: b.id, direction: 1, expectedOrder: s.followUps.map(item => item.id) });
  assert.equal(counts['turn/start'], haltedStarts);
  await api.handle(s, { action: 'queuePause', paused: true });s.busy = true;
  s.attachments = [{ id: 'independent-file', kind: 'file', path: 'synthetic/independent.js' }];
  s.draft = 'Independent composer draft';
  const edit = { id: a.id, editId: 'synthetic-attachment-editor', expectedText: a.text,
    expectedAttachmentIds: a.attachments.map(file => file.id), attachmentIds: a.attachments.map(file => file.id) };
  await api.handle(s, { ...edit, action: 'pasteQueuedImage', requestId: 'synthetic-queue-paste',
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=' });
  const image = s.queuedAttachmentDraft.attachments.find(file => file.kind === 'image');
  assert.ok(image);
  assert.equal(s.followUps[0].attachments[0].id, 'queue-original-file', 'Staging does not mutate the queued snapshot');
  await api.handle(s, { ...edit, action: 'editQueued', requestId: 'synthetic-queue-edit', text: a.text, attachmentIds: [image.id] });
  assert.equal(s.followUps[0].attachments.length, 1);assert.equal(s.followUps[0].attachments[0].id, image.id);
  assert.deepEqual(s.followUps[0].modelSelection, a.modelSelection);
  assert.equal(s.attachments[0].id, 'independent-file');assert.equal(s.draft, 'Independent composer draft');
  assert.equal(s.queuedAttachmentDraft, undefined);
  const originalOrder = s.followUps.map(item => item.id);
  for (let count = 0; count < 2; count++)
    await api.handle(s, { action: 'moveQueued', id: c.id, direction: -1, expectedOrder: s.followUps.map(item => item.id) });
  assert.deepEqual(s.followUps.map(item => item.id), [c.id, a.id, b.id]);
  assert.deepEqual(api.store.session(s.key).followUps.map(item => item.id), [c.id, a.id, b.id]);
  await assert.rejects(api.handle(s, { action: 'moveQueued', id: c.id, direction: 1, expectedOrder: originalOrder }));
  const starts = counts['turn/start'];
  const saveRecord = api.store.saveSession;
  api.store.saveSession = () => { throw Error('Synthetic pause write failure'); };
  try { await assert.rejects(api.handle(s, { action: 'queuePause', paused: false })); }
  finally { api.store.saveSession = saveRecord; }
  assert.equal(s.queuePaused, true);assert.equal(api.store.session(s.key).queuePaused, true);
  api.server().emit('notification', { method: 'turn/completed', params: { threadId: s.id, turn: { id: s.turnId, status: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(counts['turn/start'], starts);assert.equal(s.followUps.length, 3);
  assert.equal(api.store.session(s.key).queuePaused, true);
  await api.handle(s, { action: 'sendQueued' });
  assert.equal(inputs.at(-1), 'Managed C');assert.equal(s.queuePaused, true);
  api.server().emit('notification', { method: 'turn/completed', params: { threadId: s.id, turn: { id: s.turnId, status: 'completed' } } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(s.followUps.length, 2, 'Manual dispatch on pause sends exactly one task');
  await api.handle(s, { action: 'queuePause', paused: false });
  assert.equal(inputs.at(-1), 'Managed A');assert.equal(s.queuePaused, false);
  api.server().emit('notification', { method: 'turn/completed', params: { threadId: s.id, turn: { id: s.turnId, status: 'completed' } } });
  for (let n = 0; n < 200 && s.followUps.length; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(inputs.at(-1), 'Managed B');assert.equal(s.followUps.length, 0);
  assert.equal(s.attachments[0].id, 'independent-file');assert.equal(s.draft, 'Independent composer draft');
  api.server().emit('notification', { method: 'turn/completed', params: { threadId: s.id, turn: { id: s.turnId, status: 'interrupted' } } });
  // A normal completion during persistence resumes exactly the deferred drain.
  s.busy = true;
  await api.handle(s, { action: 'send', text: 'Deferred completion task' });
  const waiting = s.followUps[0], beforeDeferred = counts['turn/start'];
  const updateWorkspace = api.library.storage.update;
  let release, held = false, holdTimer;
  api.library.storage.update = function(key, value) {
    if (key !== 'session:' + s.key || held) return updateWorkspace.call(this, key, value);
    held = true;
    return new Promise((resolve, reject) => {
      holdTimer = setTimeout(() => reject(Error('Synthetic persistence hold timed out')), 5000);
      release = () => { clearTimeout(holdTimer);updateWorkspace.call(this, key, value).then(resolve, reject); };
    });
  };
  try {
    const saving = api.handle(s, { action: 'editQueued', id: waiting.id, expectedText: waiting.text,
      text: waiting.text, requestId: 'synthetic-deferred-edit' });
    assert.equal(s.queueMutation, true);
    api.server().emit('notification', { method: 'turn/completed', params: { threadId: s.id, turn: { id: s.turnId, status: 'completed' } } });
    assert.equal(counts['turn/start'], beforeDeferred);
    api.library.storage.update = updateWorkspace;release();await saving;
    for (let n = 0; n < 200 && (s.followUpSending || s.followUps.length); n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(counts['turn/start'], beforeDeferred + 1);assert.equal(inputs.at(-1), 'Deferred completion task');
  } finally { clearTimeout(holdTimer);api.library.storage.update = updateWorkspace; }
  api.server().emit('notification', { method: 'turn/completed', params: { threadId: s.id, turn: { id: s.turnId, status: 'interrupted' } } });
};
