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
module.exports={report};
