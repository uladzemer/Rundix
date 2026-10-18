const path = require('node:path');
const { randomUUID } = require('node:crypto');
const locale = require('../ui/i18n.js');
const { queuedTarget, selectedAttachments } = require('./queued-edits.cjs');

function fileAttachment(uri) {
  if (uri?.scheme !== 'file' || typeof uri.fsPath !== 'string') return null;
  return { id: randomUUID(), path: uri.fsPath, name: path.basename(uri.fsPath),
    kind: /\.(png|jpe?g|webp|gif)$/i.test(uri.fsPath) ? 'image' : 'file' };
}

async function stageQueuedAttachments(session, message, { latest, pickFiles, pasteImage }) {
  if (typeof message.editId !== 'string' || !/^[\w-]{1,100}$/.test(message.editId)) throw Error('Invalid queue editor');
  const item = queuedTarget(session, message, latest());
  const selected = selectedAttachments(session, message, item);
  let draft = session.queuedAttachmentDraft;
  if (draft?.editId !== message.editId || draft.itemId !== item.id) {
    draft = { editId: message.editId, itemId: item.id, attachments: [] };
    session.queuedAttachmentDraft = draft;
  }
  const panel = session.panel;
  const additions = message.action === 'pasteQueuedImage'
    ? [await pasteImage(message.dataUrl)]
    : (await pickFiles() || []).map(fileAttachment).filter(Boolean);
  // A native picker or file write can finish after the task/panel/editor is gone.
  if (!panel || session.panel !== panel || session.queuedAttachmentDraft !== draft) throw Error('Queue editor expired');
  queuedTarget(session, message, latest());
  const attachments = [...selected];
  for (const file of additions) {
    if (!attachments.some(existing => existing.path === file.path && existing.kind !== 'selection')) attachments.push(file);
  }
  if (attachments.length > 100) throw Error(locale.t('Можно прикрепить до 100 файлов.'));
  if (attachments.filter(file => file.kind === 'image').length > 8) throw Error(locale.t('Можно прикрепить до 8 изображений.'));
  draft.attachments = attachments;
  return attachments;
}

module.exports = { fileAttachment, stageQueuedAttachments };
