const vscode=require('vscode');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
exports.run=async()=>{
 const result={};
 const originalInput=vscode.window.showInputBox;
 try{
  const api=await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();
  const session=api.create();
  const name='Очень длинное название сессии для проверки компактной ширины родной вкладки VS Code';
  await api.handle(session,{action:'rename',name});await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(session.panel.title,require('../runtime/titles.cjs').tabTitle(name));
  assert.equal(session.name,name);assert.equal(api.store.session(session.key).name,name);
  result.compactNativeTitle=true;result.fullNamePersisted=true;
  await api.handle(session,{action:'rename',name:'Короткое имя'});await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(session.panel.title,'Короткое имя');result.shortNamesPreserved=true;
  let prompted=false;
  vscode.window.showInputBox=async options=>{prompted=true;assert.equal(options.value,'Короткое имя');assert.ok(options.validateInput(''));return 'Имя из меню вкладки';};
  await vscode.commands.executeCommand('rundix.rename',{key:session.key});await new Promise(resolve=>setTimeout(resolve,120));
  assert.equal(prompted,true);assert.equal(session.name,'Имя из меню вкладки');assert.equal(session.panel.title,session.name);result.nativeRenameCommand=true;
  prompted=false;
  vscode.window.showInputBox=async options=>{prompted=true;assert.equal(options.value,session.name);return 'Native tab menu';};
  await vscode.commands.executeCommand('rundix.rename',undefined,{groupId:0,editorIndex:0});
  assert.equal(prompted,true);assert.equal(session.name,'Native tab menu');result.nativeContextArguments=true;
  vscode.window.showInputBox=async()=>undefined;await vscode.commands.executeCommand('rundix.rename',{key:session.key});assert.equal(session.name,'Native tab menu');result.cancelKeepsName=true;
  await api.closeTab(session);result.passed=true;
 }catch(error){result.passed=false;result.error=error.message;}finally{vscode.window.showInputBox=originalInput;}
 fs.writeFileSync(path.join(__dirname,'../.verification/titles-host.json'),JSON.stringify(result,null,2));
 if(!result.passed)throw Error(result.error);
};
