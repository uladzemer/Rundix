// Shared display-only formatting. Stored transcripts and MCP reports stay intact.
const WorkbenchTaskReport=(()=>{
  function markdown(text,language) {
    let value;
    try {value=JSON.parse(text);}catch{return null;}
    if(!value || typeof value.result!=='string' || !['changedFiles','checks','remainingIssues'].every(key=>Array.isArray(value[key])))return null;
    const ru=language!=='en';
    const list=(title,items)=>items.length?'\n\n**'+title+'**\n'+items.map(item=>'- '+String(item)).join('\n'):'';
    return value.result+list(ru?'Изменённые файлы':'Changed files',value.changedFiles)+list(ru?'Проверки':'Checks',value.checks)+list(ru?'Что осталось':'Remaining issues',value.remainingIssues);
  }
  return {markdown};
})();
if(typeof module!=='undefined')module.exports=WorkbenchTaskReport;
