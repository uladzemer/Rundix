// Host state is supplied explicitly; mutable values are read through deps.
async function answerAsync(deps, s, msg) {
      const delivery=require('./mcp-delivery.cjs');
      if(s.asyncQuestionSending)throw Error('Wait for the question answer to finish sending.');
      const item=s.items.find(item=>item.id===msg.itemId);
      const previousReply=s.asyncQuestionReplies?.[msg.itemId];
      if(!item || (s.asyncQuestionReplies?.[item.id] && (s.asyncQuestionReplies[item.id]!=='unknown' || s.mcpTask || typeof msg.sendReply==='function')) || deps.asyncQuestions.hasReply(s.items,item.id))throw Error('This question has already been answered or is unavailable.');
      if(deps.mcpTasks && [...deps.mcpTasks.tasks.values()].some(task=>task.sessionKey===s.key && task.cancelledAsyncItems?.includes(item.id)))throw Error('This question belongs to a cancelled task run.');
      const text=deps.asyncQuestions.buildReply(item,msg.answers,{skip:msg.skip===true});
      // In an MCP task chat, answer through the task so its directory lease, connection and report stay consistent.
      const owner=typeof msg.sendReply!=='function' && deps.mcpTasks?[...deps.mcpTasks.tasks.values()].find(task=>task.sessionKey===s.key && deps.mcpTasks.adapter.pending(task).some(request=>request.id==='async-question:'+item.id)):null;
      if(owner){
        await deps.mcpTasks.call('continue_task',{requestId:deps.randomUUID(),taskId:owner.taskId,approval:{id:'async-question:'+item.id,...(msg.skip===true?{skip:true}:{answers:msg.answers})}});
        return;
      }
      if(deps.preflight.preparing(s.preflight))s.preflight.skipped=msg.skip===true;
      s.asyncQuestionSending=item.id;deps.publish(s);
      let attempted=false;
      try{
        // Persist before any mutating RPC so a crash or lost reply preserves delivery uncertainty.
        s.asyncQuestionReplies={...s.asyncQuestionReplies,[item.id]:'unknown'};
        await deps.save(s);
        let queued=false;
        const sendReply=async()=>{
          attempted=true;
          const result=await (typeof msg.sendReply==='function'?msg.sendReply(text):deps.send(s,text,[],{includeIde:false}));
          if(result?.waitUntil)throw Object.assign(Error(deps.locale.t('Очередь ожидает сброса лимитов. Повторите отправку позже.')),{notSent:true});
        };
        if(s.busy){
          attempted=true;
          if(!await deps.steer(s,text,[])){
            attempted=false;
            if(typeof msg.sendReply==='function'){
              if(s.busy)throw Object.assign(Error('The turn is finishing. Retry the question answer after its status updates.'),{notSent:true});
              await sendReply();
            }else{await deps.queueFollowUp(s,text,[]);queued=true;}
          }
        }else await sendReply();
        s.asyncQuestionReplies={...s.asyncQuestionReplies,[item.id]:queued?'queued':msg.skip===true?'skipped':'sent'};
        deps.questionRecords.remember(s,{id:'a:'+item.id,origin:'async',parentItemId:item.id,questions:deps.questionRecords.fromAsync(item),answers:msg.answers,skipped:msg.skip===true,status:queued?'queued':'sent'});
        await deps.save(s);
      }catch(error){
        s.asyncQuestionReplies={...s.asyncQuestionReplies};
        if(!attempted || delivery.refused(error)){
          if(previousReply==='unknown')s.asyncQuestionReplies[item.id]='unknown';
          else delete s.asyncQuestionReplies[item.id];
          await deps.save(s);throw Object.assign(error,{deliveryOutcome:'rejected'});
        }
        s.asyncQuestionReplies[item.id]='unknown';
        try{await deps.save(s);}catch{}
        throw delivery.unknown(error);
      }finally{s.asyncQuestionSending=null;deps.publish(s);}

}
module.exports = { answerAsync };
