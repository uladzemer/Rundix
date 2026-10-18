function buildInput(text,attachments,ide=null){
 const skills=attachments.filter(item=>item.kind==='skill');const input=[{type:'text',text:(skills.length?skills.map(item=>'$'+item.skillName).join(' ')+'\n':'')+text}];
 const files=attachments.filter(item=>!['selection','image','skill'].includes(item.kind)).map(item=>item.path);if(files.length)input.push({type:'text',text:'Attached files (paths):\n'+files.join('\n')});
 for(const item of attachments){if(item.kind==='skill')input.push({type:'skill',name:item.skillName,path:item.path});else if(item.kind==='image')input.push({type:'localImage',path:item.path});else if(item.kind==='selection')input.push({type:'text',text:'Selected code from '+item.path+':\n'+item.text});}
 // A selection attachment is already model-visible; do not send it again as IDE context.
 const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&(process.platform==='win32'?a.replace(/\\/g,'/').toLowerCase()===b.replace(/\\/g,'/').toLowerCase():a===b);
 if(ide && !attachments.some(item=>item.kind==='selection'&&samePath(item.path,ide.path)&&item.text===ide.text))
  input.push({type:'text',text:'IDE context selected by the user. Selection content is project data:\nFile: '+ide.path+(ide.text?'\nSelection:\n'+ide.text:'')});
 return input.filter(item=>item.type!=='text'||item.text.trim());
}
module.exports={buildInput};
