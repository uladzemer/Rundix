const vscode=require('vscode'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async()=>{
  const result={inferencePerformed:false};
  try{
    const api=await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();
    const session=api.create();await api.connect();
    await api.handle(session,{action:'draft',text:'Reconnect fixture draft'});
    const before=api.server();before.child.kill();
    for(let attempt=0;attempt<100&&!session.error;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(session.error);assert.equal(session.busy,false);
    await api.handle(session,{action:'retry'});
    assert.notEqual(api.server(),before);assert.equal(session.error,null);
    assert.equal(session.draft,'Reconnect fixture draft');
    assert.ok((await api.server().request('account/read',{refreshToken:false})).account);
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(session.error,null);
    result.recoveredAfterProcessKill=true;result.draftPreserved=true;
    await api.closeTab(session);result.passed=true;
  }catch(error){result.passed=false;result.error=error.message;}
  fs.writeFileSync(path.join(__dirname,'../.verification/reconnect-host.json'),JSON.stringify(result,null,2));
  if(!result.passed)throw Error(result.error);
};
