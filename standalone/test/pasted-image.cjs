const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {savePastedImage}=require('../runtime/pasted-image.cjs');
const {buildInput}=require('../runtime/input.cjs');
(async()=>{
 const root=await fs.mkdtemp(path.join(require('node:os').tmpdir(),'clipboard-image-'));
 try{
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
  const image=await savePastedImage(root,'data:image/png;base64,'+png);
  assert.equal(image.kind,'image');assert.equal(image.pasted,true);
  assert.equal((await fs.readFile(image.path)).toString('base64'),png);
  assert.deepEqual(buildInput('',[image]),[{type:'localImage',path:image.path}]);
  assert.equal(buildInput('Describe this',[image])[0].text,'Describe this');
  await assert.rejects(savePastedImage(root,'data:image/svg+xml;base64,PHN2Zz4='));
  await assert.rejects(savePastedImage(root,'data:image/png;base64,aGVsbG8='));
  await assert.rejects(savePastedImage(root,'data:image/png;base64,'+'A'.repeat(29*1024*1024)));
  console.log('Pasted images: binary persistence, official localImage input, image-only input, type/signature and size rejection passed.');
 }finally{await fs.rm(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
