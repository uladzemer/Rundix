const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {messageImages}=require('../runtime/message-images.cjs');
const {itemText}=require('../runtime/session.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-message-images-'));
try{
 const root=path.join(dir,'images');fs.mkdirSync(root);const file=path.join(root,'one.png');fs.writeFileSync(file,'synthetic');
 const item={type:'userMessage',content:[{type:'text',text:'Describe this screenshot'},{type:'localImage',path:file},{type:'image',url:'https://untrusted.example/image.png'},{type:'localImage',path:path.join(dir,'outside.png')}]};
 assert.equal(itemText(item),'Describe this screenshot');
 const result=messageImages(item,root,()=> 'webview://safe-image');
 assert.equal(result.length,3);assert.equal(result[0].preview,'webview://safe-image');assert.equal(result[1].preview,null);assert.equal(result[2].preview,null);
 assert.ok(!JSON.stringify(result).includes(file));
 const inline={type:'userMessage',content:[{type:'image',url:'data:image/png;base64,aGVsbG8='},{type:'image',url:'data:image/svg+xml;base64,aGVsbG8='}]};
 assert.equal(messageImages(inline,root,String)[0].preview,inline.content[0].url);assert.equal(messageImages(inline,root,String)[1].preview,null);
 assert.equal(itemText(inline),'');
 console.log('PASS: sent-image extraction, text without local image paths, safe clipboard previews and unavailable-image markers.');
}finally{fs.rmSync(path.join(dir,'images','one.png'),{force:true});fs.rmdirSync(path.join(dir,'images'));fs.rmdirSync(dir);}
