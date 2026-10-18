const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const MAX_IMAGE_BYTES=20*1024*1024;
async function savePastedImage(root,dataUrl){
  if(typeof dataUrl!=='string'||dataUrl.length>Math.ceil(MAX_IMAGE_BYTES/3)*4+100)throw Error('Image exceeds 20 MB.');
  const match=/^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if(!match)throw Error('Unsupported clipboard image. Use PNG, JPEG, GIF or WebP.');
  const data=Buffer.from(match[2],'base64'),type=match[1];
  if(!data.length||data.length>MAX_IMAGE_BYTES||data.toString('base64')!==match[2])throw Error('Invalid clipboard image.');
  const valid=type==='png'?data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):
    type==='jpeg'?data[0]===255&&data[1]===216&&data[2]===255:
    type==='gif'?['GIF87a','GIF89a'].includes(data.subarray(0,6).toString()):
    data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP';
  if(!valid)throw Error('Invalid clipboard image.');
  await fs.mkdir(root,{recursive:true});
  const id=randomUUID(),file=path.join(root,id+'.'+(type==='jpeg'?'jpg':type));
  await fs.writeFile(file,data,{flag:'wx',mode:0o600});
  return {id,path:file,name:'Clipboard '+id.slice(0,8)+'.'+(type==='jpeg'?'jpg':type),kind:'image',pasted:true};
}
module.exports={savePastedImage,MAX_IMAGE_BYTES};
