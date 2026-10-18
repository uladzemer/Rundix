const SKIPPED = 'The user skipped this quiz. No options were selected. Continue with reasonable assumptions where possible; do not treat recommended options as consent.';

function remember(session, {id, origin, parentItemId, questions, answers, skipped=false, status='sent'}) {
  const safeAnswers = Object.fromEntries(questions.map(question => [question.id,
    skipped ? '' : question.isSecret ? '••••' : answers[question.id]]));
  const record = {id, origin, parentItemId, questions, answers:safeAnswers, skipped, status, timestamp:Date.now()};
  session.questionHistory = [...(session.questionHistory || []).filter(previous => previous.id !== id),record].slice(-100);
  return record;
}

function fromAsync(item) {
  return item.questions.map((question,index) => ({id:String(index),question:question.title,
    options:(question.options || []).map(label=>({label}))}));
}

function restore(session){
  const asyncQuestions=require('./async-questions.cjs');
  for(const item of session.items){
    if(!asyncQuestions.questions(item).length)continue;
    const replies=asyncQuestions.findReplies(session.items,item.id);
    if(!replies.length)continue;
    const answers=Object.fromEntries(replies.map(reply=>[String(JSON.parse(reply.questionItemId)[2]),reply.answer]));
    if(!item.questions.every((_,index)=>typeof answers[index]==='string'))continue;
    const skipped=Object.values(answers).every(answer=>answer===SKIPPED);
    session.asyncQuestionReplies={...session.asyncQuestionReplies,[item.id]:skipped?'skipped':'sent'};
    const existing=session.questionHistory?.find(record=>record.id==='a:'+item.id);
    if(existing)existing.status='sent';
    else remember(session,{id:'a:'+item.id,origin:'async',parentItemId:item.id,questions:fromAsync(item),answers,skipped});
  }
}

module.exports = {SKIPPED,remember,fromAsync,restore};
