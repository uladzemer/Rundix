// Display-only limits. Durable inputs, reports and transcripts are never modified.
function report(value) {
  if(!value)return null;
  let truncated=false;
  const clip=(value,max)=>{
    const text=typeof value==='string'?value:JSON.stringify(value),bytes=Buffer.from(text);
    if(bytes.length<=max)return text;
    truncated=true;let end=max;while(end>0 && (bytes[end]&0xc0)===0x80)end--;
    return bytes.subarray(0,end).toString('utf8');
  };
  const rows=value=>{if((value || []).length>4)truncated=true;return (value || []).slice(0,4).map(row=>clip(row,200));};
  const result={result:clip(value.result || '',500),changedFiles:rows(value.changedFiles),checks:rows(value.checks),remainingIssues:rows(value.remainingIssues)};
  return {...result,truncated};
}
function text(value,max=16384) {
  const bytes=Buffer.from(value || '');if(bytes.length<=max)return {text:value || '',truncated:false};
  let end=max;while(end>0 && (bytes[end]&0xc0)===0x80)end--;
  return {text:bytes.subarray(0,end).toString('utf8'),truncated:true};
}
function transcript(items) {
  const result=[];let bytes=0,itemsTruncated=false;
  for(const item of items.slice(-200).reverse()) {
    const original=require('./session.cjs').itemText(item);
    const display=limit=>({id:item.id,type:item.type,...text(original,limit),timestamp:item.timestamp});
    let row=display(16384),size=Buffer.byteLength(JSON.stringify(row));
    if(size>16384){
      let low=0,high=16384;
      while(low<high){const middle=Math.ceil((low+high)/2);if(Buffer.byteLength(JSON.stringify(display(middle)))<=16384)low=middle;else high=middle-1;}
      row=display(low);size=Buffer.byteLength(JSON.stringify(row));
      if(size>16384)throw Object.assign(Error('response_too_large'),{code:'response_too_large'});
    }
    if(bytes+size>384*1024){itemsTruncated=true;break;}
    bytes+=size;itemsTruncated ||= row.truncated;result.push(row);
  }
  return {items:result.reverse(),itemsTruncated,historyTruncated:items.length>result.length};
}
module.exports={report,text,transcript};
