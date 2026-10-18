(function(root){
 const modes=[
  {id:'manual',label:'Вручную',icon:'hand',description:'Чтение без изменений; запись требует разрешения',access:'read',reviewer:'user'},
  {id:'workspace',label:'Запрашивать разрешение',icon:'code',description:'Изменения внутри проекта; расширенные действия — с разрешения',access:'workspace',reviewer:'user'},
  {id:'plan',label:'План',icon:'plan',description:'Исследовать проект и обсудить план перед изменениями',access:'read',reviewer:'user',plan:true},
  {id:'auto',label:'Подтверждать за меня',icon:'bolt',description:'Штатная автоматическая проверка запросов разрешений Codex',access:'workspace',reviewer:'auto_review'},
  {id:'full',label:'Полный доступ',icon:'shield-warning',description:'Полный доступ к файлам и сети, включая действия вне проекта',access:'full',reviewer:'user'}
 ];
 function current(prefs={}){return modes.find(m=>m.id===prefs.mode)||modes.find(m=>m.id===(prefs.plan?'plan':prefs.access==='full'?'full':prefs.access==='read'?'manual':'workspace'));}
 function policy(mode,cwd){const m=modes.find(m=>m.id===mode);if(!m)throw Error('Неизвестный режим работы.');return {approvalPolicy:m.access==='full'?'never':'on-request',approvalsReviewer:m.reviewer,sandbox:m.access==='full'?'danger-full-access':m.access==='read'?'read-only':'workspace-write',sandboxPolicy:m.access==='full'?{type:'dangerFullAccess'}:m.access==='read'?{type:'readOnly'}:{type:'workspaceWrite',writableRoots:cwd?[cwd]:[],networkAccess:false}};}
 const api={modes,current,policy};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WorkbenchModes=api;
})(globalThis);
