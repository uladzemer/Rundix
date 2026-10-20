const vscode=require('vscode'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.run=async()=>{
 const report={inferencePerformed:false};let api,session,originalPost;
 try{
  api=await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();session=api.create();
  const dataUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
  await api.handle(session,{action:'pasteImage',requestId:'test-paste',dataUrl});
  const image=session.attachments.at(-1);assert.equal(image.kind,'image');assert.equal(image.pasted,true);
  assert.equal(fs.readFileSync(image.path).toString('base64'),dataUrl.split(',')[1]);
  assert.ok(api.view(session).panel.webview.options.localResourceRoots.some(uri=>image.path.startsWith(uri.fsPath+path.sep)));
  assert.deepEqual(require('../runtime/input.cjs').buildInput('',[image]),[{type:'localImage',path:image.path}]);
  report.savedImageAndNativeInput=true;report.previewResourceAllowed=true;
  await api.handle(session,{action:'draft',text:'Describe image'});assert.equal(session.attachments.length,1);
  const states=[];originalPost=api.view(session).panel.webview.postMessage;
  api.view(session).panel.webview.postMessage=async message=>{if(message.type==='state')states.push(message.data);return true;};
  session.items.push({id:'sent-image-fixture',type:'userMessage',content:[{type:'text',text:'Describe image'},{type:'localImage',path:image.path}]});
  await api.handle(session,{action:'removeAttachment',id:image.id});assert.equal(session.attachments.length,0);
  await new Promise(resolve=>setTimeout(resolve,150));
  const sent=states.at(-1)?.items.find(item=>item.id==='sent-image-fixture');
  assert.equal(sent?.images.length,1);assert.ok(sent.images[0].preview);assert.equal(sent.text,'Describe image');report.sentMessageThumbnail=true;
  fs.unlinkSync(image.path);report.removal=true;report.passed=true;
 }catch{report.passed=false;}
 finally{
  if(session && originalPost)api.view(session).panel.webview.postMessage=originalPost;
  api?.view(session)?.panel?.dispose();
  fs.mkdirSync(path.join(__dirname,'../.verification'),{recursive:true});
  fs.writeFileSync(path.join(__dirname,'../.verification/pasted-image-host.json'),JSON.stringify(report,null,2));
 }
 if(!report.passed)throw Error('Native pasted image check failed');
};
