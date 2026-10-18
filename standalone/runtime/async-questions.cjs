function questions(item) {
  if (item?.type !== 'agentMessage' || !Array.isArray(item.questions) || !item.questions.length || item.questions.length > 3) return [];
  if (!item.questions.every(question => typeof question.title === 'string' && question.title.length <= 20000 &&
    (question.options == null || Array.isArray(question.options) && question.options.length <= 20 &&
      question.options.every(option => typeof option === 'string' && option.length <= 20000)))) return [];
  return item.questions;
}

function buildReply(item, answers, {skip=false}={}) {
  const rows = questions(item);
  if (!rows.length) throw Error('This question is no longer available.');
  const replies = rows.map((question, index) => {
    const answer = skip ? require('./question-records.cjs').SKIPPED : answers?.[String(index)];
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 20000) throw Error('Answer every question.');
    return {questionItemId: JSON.stringify(['request_user_input_async', item.id, index]), question: question.title, answer};
  });
  const content = JSON.stringify(replies).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  if (content.length > 180000) throw Error('Question answers are too long.');
  return '<send_user_message_question_reply>\n' + content + '\n</send_user_message_question_reply>';
}

function findReplies(items, itemId) {
  for(const item of items.slice().reverse()) {
    if (item.type !== 'userMessage') continue;
    const text = item.text || (item.content || []).map(part => part.text || '').join('\n');
    const match = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(text.trim());
    if (!match) continue;
    try {
      const replies = JSON.parse(match[1]);
      const found=Array.isArray(replies)?replies.filter(reply => {
        if(typeof reply.answer!=='string')return false;
        const id = JSON.parse(reply.questionItemId);
        return Array.isArray(id) && id[0] === 'request_user_input_async' && id[1] === itemId;
      }):[];
      if(found.length)return found;
    } catch { /* An ordinary malformed user envelope is not a protocol reply. */ }
  }
  return [];
}

function hasReply(items,itemId){return findReplies(items,itemId).length>0;}

function displayReply(text) {
  const match=/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(text.trim());
  if(!match)return null;
  try{
    const replies=JSON.parse(match[1]);
    if(!Array.isArray(replies) || !replies.length || !replies.every(reply=>typeof reply.question==='string' && typeof reply.answer==='string'))return null;
    if(replies.every(reply=>reply.answer===require('./question-records.cjs').SKIPPED))return require('../ui/i18n.js').t('Квиз пропущен');
    return replies.map(reply=>reply.question+'\n'+reply.answer).join('\n\n');
  }catch{return null;}
}

module.exports = {questions, buildReply, hasReply, displayReply,findReplies};
