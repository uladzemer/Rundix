// Plain session actions shared by editor input and MCP execution.
async function stop(deps, s) {
  deps.capacityRecovery?.cancel(s);
  s.stopRequested=true;
  if(s.id && s.turnId)await deps.server.request("turn/interrupt",{threadId:s.id,turnId:s.turnId});
}
async function answer(deps, s, msg) {
  const request = deps.pendingRequests.get(String(msg.id));
  if (
    !request ||
    (request.params.threadId && request.params.threadId !== s.id)
  )
    return;
  let result;
  if (request.method === "item/tool/requestUserInput") {
    const entries = (request.params.questions || []).map(question => {
      if(msg.skip===true)return [question.id,{answers:[]}];
      const answer = msg.answers?.[question.id];
      if (typeof answer !== "string" || !answer.trim() || answer.length>20000)
        throw Error(deps.locale.t("Ответьте на все вопросы."));
      return [question.id,{answers:[answer]}];
    });
    result = {answers:Object.fromEntries(entries)};
    if(deps.preflight.preparing(s.preflight))s.preflight.skipped=msg.skip===true;
  } else if (request.method === "item/permissions/requestApproval") {
    if (!["accept", "decline"].includes(msg.decision)) return;
    result = {
      permissions:
        msg.decision === "accept" ? request.params.permissions : {},
      scope: "turn",
    };
  } else if (request.method === "mcpServer/elicitation/request") {
    if (!["accept", "decline", "cancel"].includes(msg.decision)) return;
    if (msg.decision === "accept" && request.params.mode === "form")
      result = {
        action: "accept",
        content: deps.forms.validate(
          request.params.requestedSchema,
          msg.content,
        ),
      };
    else if (msg.decision === "accept" && request.params.mode === "url")
      result = { action: "accept", content: null };
    else if (msg.decision === "accept")
      throw Error(
        deps.locale.t("Этот тип подтверждения пока не поддерживается."),
      );
    else result = { action: msg.decision, content: null };
  } else {
    if (
      !["accept", "acceptForSession", "decline", "cancel"].includes(
        msg.decision,
      )
    )
      return;
    if (
      request.params.availableDecisions &&
      !request.params.availableDecisions.includes(msg.decision)
    )
      throw Error(deps.locale.t("Это решение недоступно для данного запроса."));
    result = { decision: msg.decision };
  }
  deps.server.respond(request.id, result);
  deps.pendingRequests.delete(String(msg.id));
  if(request.method==='item/tool/requestUserInput'){
    deps.questionRecords.remember(s,{id:'b:'+(request.params.itemId || request.id),origin:'blocking',parentItemId:request.params.itemId || null,
      questions:request.params.questions || [],answers:msg.answers,skipped:msg.skip===true});
    await deps.save(s);
  }
  deps.broadcast();
}
module.exports = {stop, answer};
