// Actual Extension Host projection -> Chrome rendering -> answer payload.
// The host fixture replaces CLI/network; no credentials or inference are used.
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const root=path.join(__dirname,'..');
if(process.platform!=='win32')throw Error('This integration runner currently requires Windows and the local VS Code test host.');
const fixture=path.join(root,'.verification/quiz-published-state.json');
if(fs.existsSync(fixture))fs.unlinkSync(fixture);
function run(command,args,env=process.env){
  const result=spawnSync(command,args,{cwd:root,env,stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status || 1);
}
run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','test/host.ps1','-TestFile','startup-host.cjs']);
if(!fs.existsSync(fixture))throw Error('Host did not produce a fresh published state fixture.');
run(process.execPath,['test/browser.cjs'],{...process.env,QUIZ_FROM_HOST:'1'});
console.log('PASS: actual host notification and webview projection render clickable quiz choices and generate the correlated answer action.');
