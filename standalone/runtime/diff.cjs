// Reconstruct a read-only before/after view only when a unified patch matches exactly.
function applyUnified(current,diff,reverse=false){
 const lines=String(diff).replace(/\r\n/g,'\n').split('\n'),source=String(current).replace(/\r\n/g,'\n');
 const input=source===''?[]:source.split('\n');if(input.at(-1)==='')input.pop();
 const output=[];let cursor=0,found=false,noFinalNewline=false;
 for(let i=0;i<lines.length;i++){
  const header=lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);if(!header)continue;found=true;
  const oldStart=Number(header[1]),oldCount=header[2]===undefined?1:Number(header[2]),newStart=Number(header[3]),newCount=header[4]===undefined?1:Number(header[4]);
  const start=reverse?newStart:oldStart,count=reverse?newCount:oldCount,offset=count===0?start:Math.max(0,start-1);
  if(offset<cursor||offset>input.length)throw Error('Patch position does not match the current file.');
  output.push(...input.slice(cursor,offset));cursor=offset;let consumedOld=0,consumedNew=0,lastPrefix;
  while(i+1<lines.length){const line=lines[i+1];if(line.startsWith('@@ ')||line.startsWith('diff --git ')||line.startsWith('--- ')&&consumedOld===oldCount&&consumedNew===newCount)break;
   if(line.startsWith('\\ No newline')){if(lastPrefix===' '||lastPrefix===(reverse?'-':'+'))noFinalNewline=true;i++;continue;}
   const prefix=line[0];if(![' ','+','-'].includes(prefix)||consumedOld===oldCount&&consumedNew===newCount)break;i++;lastPrefix=prefix;const text=line.slice(1);
   if(prefix!=='-')consumedNew++;if(prefix!=='+')consumedOld++;
   if(prefix===' '||prefix===(reverse?'+':'-')){if(input[cursor]!==text)throw Error('Patch contents do not match the current file.');cursor++;}
   if(prefix===' '||prefix===(reverse?'-':'+'))output.push(text);
  }
  if(consumedOld!==oldCount||consumedNew!==newCount)throw Error('Incomplete patch.');
 }
 if(!found)throw Error('No unified patch hunks.');const unchangedTail=cursor<input.length;output.push(...input.slice(cursor));const finalNewline=unchangedTail?source.endsWith('\n'):!noFinalNewline;return output.join('\n')+(output.length&&finalNewline?'\n':'');
}
function versions(current,diff){try{return {before:applyUnified(current,diff,true),after:current};}catch{try{return {before:current,after:applyUnified(current,diff,false)};}catch{return null;}}}
module.exports={applyUnified,versions};
