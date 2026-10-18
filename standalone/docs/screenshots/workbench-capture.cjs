// Launch an isolated real VS Code workbench; capture its renderer read-only.
// Scene changes use the synthetic Extension Host fixture, never user input.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {randomUUID} = require('node:crypto');
const {spawn,spawnSync} = require('node:child_process');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname,'../..');
const control = path.join(root,`.verification/workbench-demo-${randomUUID()}-control.json`);
const status = control.replace(/\.json$/,'-status.json');
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));

async function waitForScene(revision,deadline) {
  while(Date.now()<deadline) {
    let state;
    try {state=JSON.parse(fs.readFileSync(status,'utf8').replace(/^\uFEFF/,''));}
    catch(error) {if(error.code!=='ENOENT' && !(error instanceof SyntaxError))throw error;}
    if(state?.error)throw Error('The isolated workbench fixture failed.');
    if(state?.ready && state.revision===revision)return;
    await delay(200);
  }
  throw Error('Timed out waiting for the synthetic workbench scene.');
}

async function capture() {
  if(process.platform!=='win32')throw Error('The native workbench capture requires Windows and VS Code.');
  fs.mkdirSync(path.dirname(control),{recursive:true});
  fs.writeFileSync(status,JSON.stringify({ready:false}));
  const port = await new Promise((resolve,reject)=>{
    const probe=net.createServer();probe.once('error',reject);
    probe.listen(0,'127.0.0.1',()=>{const value=probe.address().port;probe.close(()=>resolve(value));});
  });
  const host=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'workbench-demo.ps1'),'-CapturePort',String(port),'-ControlPath',control],{windowsHide:true,stdio:'inherit'});
  let exitCode;
  let spawnError;
  host.once('exit',code=>{exitCode=code;});
  host.once('error',error=>{spawnError=error;});
  let browser;
  let revision=1;
  try {
    await waitForScene(revision,Date.now()+90000);
    if(spawnError)throw spawnError;
    browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});
    const matches=[];
    for(const page of await browser.pages()) if((await page.title()).includes('Rundix Demo'))matches.push(page);
    if(matches.length!==1)throw Error('Expected exactly one isolated demo workbench.');
    const page=matches[0];
    const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
    if(viewport.width<1280 || viewport.height<800)throw Error('Use a desktop large enough for the complete workbench tour.');
    for(const scene of ['overview','tests','split','queue','access','history','questions']) {
      fs.writeFileSync(control,JSON.stringify({scene,revision:++revision}));
      await waitForScene(revision,Date.now()+30000);
      await page.screenshot({path:path.join(__dirname,`workbench-${scene}.jpg`),type:'jpeg',quality:90});
    }
    const result=spawnSync(process.env.PYTHON || 'python',[path.join(__dirname,'tour.py')],{stdio:'inherit'});
    if(result.error)throw result.error;
    if(result.status!==0)throw Error('Install Pillow for the workbench GIF.');
    console.log('Captured seven real workbench scenes with synthetic content; no model request or sign-in performed.');
  } finally {
    browser?.disconnect();
    fs.writeFileSync(control,JSON.stringify({scene:'done',revision:++revision}));
    const deadline=Date.now()+15000;
    while(exitCode===undefined && !spawnError && Date.now()<deadline)await delay(200);
    if(exitCode!==0)throw Error('The isolated workbench did not exit cleanly.');
  }
}
// Output images are shared documentation assets: fail closed on a second run.
async function runExclusive() {
  fs.mkdirSync(path.join(root,'.verification'),{recursive:true});
  const lock=path.join(root,'.verification/workbench-capture.lock');
  let handle;
  try { handle=fs.openSync(lock,'wx'); }
  catch(error) {
    if(error.code==='EEXIST')throw Error('Another capture owns the output images. If an interrupted capture left a lock, verify it has stopped before removing the lock.');
    throw error;
  }
  try { await capture(); }
  finally { fs.closeSync(handle);fs.unlinkSync(lock); }
}
runExclusive().catch(error=>{console.error(error.message);process.exitCode=1;});
