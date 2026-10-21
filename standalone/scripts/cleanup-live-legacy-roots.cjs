// Explicit maintenance command; never invoked by extension activation.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {SessionStore}=require('../runtime/store.cjs');
const {parseStrict}=require('../runtime/service-json.cjs');
const {canonical}=require('../runtime/service-space.cjs');
function cleanup({root,temp=os.tmpdir(),apply=false,expected=3}){
  const fail=code=>{throw Object.assign(Error(code),{code});};
  if(!fs.existsSync(root))fail('registry_missing');
  const store=new SessionStore(root),release=store.acquire('legacy-roots');
  try{
    const file=store.file('legacy','roots'),info=fs.lstatSync(file);
    if(!info.isFile() || info.isSymbolicLink() || info.size>1024*1024)fail('registry_invalid');
    const bytes=fs.readFileSync(file),value=parseStrict(bytes);
    if(value.schemaVersion!==1 || !Array.isArray(value.roots) || value.roots.some(p=>typeof p!=='string' || !path.isAbsolute(p)))fail('registry_invalid');
    const tempRoot=canonical(temp);
    const selected=value.roots.filter(source=>{
      const relative=path.relative(tempRoot,source).replaceAll('\\','/').toLowerCase();
      return /^rundix-(?:live|n7|n8)-[^/]+\/vscode-profile\/user\/globalstorage\/local-rundix-tools\.rundix$/.test(relative);
    });
    if(selected.length!==expected)fail('unexpected_candidate_count');
    if(apply){
      fs.writeFileSync(file+'.cleanup-'+require('node:crypto').randomUUID()+'.bak',bytes,{flag:'wx',mode:0o600});
      store.write('legacy','roots',{...value,roots:value.roots.filter(source=>!selected.includes(source))});
    }
    return {candidates:selected.length,remaining:value.roots.length-selected.length,applied:apply};
  }finally{release();}
}
if(require.main===module){
  if(process.argv.slice(2).some(arg=>arg!=='--apply')){console.error('invalid_arguments');process.exitCode=1;}
  else try{console.log(JSON.stringify(cleanup({root:require('../runtime/service-endpoint.cjs').locations().directory,apply:process.argv.includes('--apply')})));}
  catch(error){console.error(error.code || 'cleanup_failed');process.exitCode=1;}
}
module.exports={cleanup};
