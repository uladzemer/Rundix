const path=require('node:path');
class ProjectFiles {
 constructor(enumerate){this.enumerate=enumerate;this.entries=new Map();}
 clear(){this.entries.clear();}
 async search(root,query=''){
  if(!root)return {files:[],truncated:false};const key=path.resolve(root);let entry=this.entries.get(key);
  if(!entry||Date.now()-entry.time>5000){entry={time:Date.now(),promise:this.enumerate(key)};this.entries.set(key,entry);}
  let paths;try{paths=await entry.promise;}catch(error){this.entries.delete(key);throw error;}
  const needle=query.slice(0,200).replace(/\\/g,'/').toLocaleLowerCase();
  const files=paths.map(file=>({path:file,relative:path.relative(key,file).replace(/\\/g,'/')})).filter(file=>file.relative&&!file.relative.startsWith('../')&&!path.isAbsolute(file.relative)&&file.relative.toLocaleLowerCase().includes(needle));
  files.sort((a,b)=>{const score=file=>path.basename(file.relative).toLocaleLowerCase().startsWith(needle)?0:1;return score(a)-score(b)||a.relative.localeCompare(b.relative);});return {files:files.slice(0,100),truncated:paths.length>=10000||files.length>100};
 }
}
module.exports={ProjectFiles};
