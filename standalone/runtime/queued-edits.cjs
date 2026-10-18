const locale = require('../ui/i18n.js');
const asyncQuestions = require('./async-questions.cjs');

function matchesIds(value, expected, limit) {
  if (!Array.isArray(value) || value.length > limit || value.length !== expected.length) return false;
  for (let index = 0; index < value.length; index++) {
    const id = value[index];
    if (typeof id !== 'string' || id.length > 128 || id !== expected[index]) return false;
  }
  return true;
}

function canEditQueued(item) {
  return !item.deliveryUncertain && !asyncQuestions.displayReply(item.text || '');
}

function assertQueueCurrent(session, latest) {
  if (session.persistedRecord && (!latest || JSON.stringify(latest.followUps) !== JSON.stringify(session.persistedRecord.followUps) ||
      !!latest.queuePaused !== !!session.persistedRecord.queuePaused))
    throw Error(locale.t('Сохранённая очередь изменилась. Откройте чат заново перед редактированием.'));
}

function queuedTarget(session, message, latest) {
  if (session.followUpSending) throw Error(locale.t('Дождитесь отправки сообщения из очереди.'));
  assertQueueCurrent(session, latest);
  const item = session.followUps?.find(row => row.id === message.id);
  if (!item) throw Error(locale.t('Задача уже отправлена или удалена из очереди.'));
  if (!canEditQueued(item)) throw Error(locale.t('Это сообщение нельзя редактировать.'));
  if (typeof message.expectedText !== 'string' || item.text !== message.expectedText)
    throw Error(locale.t('Текст задачи уже изменился. Откройте её заново.'));
  if (message.expectedAttachmentIds !== undefined && !matchesIds(message.expectedAttachmentIds, item.attachments.map(file => file.id), 100))
    throw Error(locale.t('Текст задачи уже изменился. Откройте её заново.'));
  return item;
}

function selectedAttachments(session, message, item) {
  if (message.attachmentIds === undefined) return item.attachments;
  const ids = message.attachmentIds;
  if (!Array.isArray(ids) || ids.length > 100)
    throw Error(locale.t('Некорректный список вложений.'));
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || id.length > 128 || seen.has(id)) throw Error(locale.t('Некорректный список вложений.'));
    seen.add(id);
  }
  const draft = session.queuedAttachmentDraft;
  const staged = draft?.editId === message.editId && draft.itemId === item.id ? draft.attachments : [];
  const allowed = new Map([...item.attachments, ...staged].map(file => [file.id, file]));
  const attachments = ids.map(id => allowed.get(id));
  if (attachments.some(file => !file)) throw Error(locale.t('Вложение больше недоступно. Откройте задачу заново.'));
  if (attachments.filter(file => file.kind === 'image').length > 8) throw Error(locale.t('Можно прикрепить до 8 изображений.'));
  return attachments;
}

function queuedEdit(session, message, latest) {
  const item = queuedTarget(session, message, latest);
  const attachments = selectedAttachments(session, message, item);
  if (typeof message.text !== 'string' || message.text.length > 200000 ||
      (!message.text.trim() && !attachments.some(file => file.kind === 'image')))
    throw Error(locale.t('Введите сообщение длиной до 200 000 символов.'));
  return item;
}

function moveQueued(session, message, latest) {
  if (session.followUpSending) throw Error(locale.t('Дождитесь отправки сообщения из очереди.'));
  assertQueueCurrent(session, latest);
  const queue = session.followUps || [];
  if (!matchesIds(message.expectedOrder, queue.map(item => item.id), 20) || ![-1, 1].includes(message.direction))
    throw Error(locale.t('Порядок очереди уже изменился. Повторите действие.'));
  const index = queue.findIndex(item => item.id === message.id), next = index + message.direction;
  if (index < 0 || next < 0 || next >= queue.length) throw Error(locale.t('Задача уже отправлена или удалена из очереди.'));
  const result = [...queue];
  [result[index], result[next]] = [result[next], result[index]];
  return result;
}

module.exports = { canEditQueued, queuedEdit, queuedTarget, selectedAttachments, assertQueueCurrent, moveQueued };
