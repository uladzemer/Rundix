const fs=require('node:fs'),path=require('node:path');
function messageImages(item,root,toUri){
 if(item.type!=='userMessage')return [];
 return (item.content || []).filter(part=>['image','localImage'].includes(part.type)).map(part=>{
  let preview=null;
  if(part.type==='localImage' && typeof part.path==='string'){
   try{
    const base=fs.realpathSync(root),file=fs.realpathSync(part.path),relative=path.relative(base,file);
    if(relative && !relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative) && fs.statSync(file).isFile())preview=toUri(file);
   }catch{}
  }else if(typeof part.url==='string' && part.url.length<=28*1024*1024 && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(part.url))preview=part.url;
  return {preview};
 });
}
module.exports={messageImages};
