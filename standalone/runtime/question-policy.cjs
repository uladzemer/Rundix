// Host state is supplied explicitly; mutable values are read through deps.
function hasPendingQuestions(deps, s) {
  const unanswered = s.items.some(item =>
    deps.asyncQuestions.questions(item).length &&
    (!s.asyncQuestionReplies?.[item.id] || s.asyncQuestionReplies[item.id]==='unknown' && !s.mcpTask) &&
    !deps.asyncQuestions.hasReply(s.items, item.id));
  return unanswered || [...deps.pendingRequests.values()].some(request => request.params?.threadId === s.id);
}
module.exports = { hasPendingQuestions };
