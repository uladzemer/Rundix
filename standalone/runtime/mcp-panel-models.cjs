const {preferredModel,normalizeModel,normalizeEffort}=require('./mcp-model.cjs');
const failure=()=>Object.assign(Error('Invalid model or effort selection.'),{code:'invalid_selection'});
const catalogView=list=>list.map(entry=>({model:entry.model,displayName:entry.displayName || entry.model,
  defaultEffort:entry.defaultEffort ?? entry.defaultReasoningEffort ?? null,
  efforts:entry.efforts || (entry.supportedReasoningEfforts || []).map(option=>option.reasoningEffort)}));
function panelDefaults(inspect) {
  return {model:normalizeModel(inspect('mcpDefaultModel')?.globalValue) ?? null,
    effort:normalizeEffort(inspect('mcpDefaultEffort')?.globalValue) || 'auto'};
}
function validateDefaults(model,effort,models) {
  if(model!==null && (typeof model!=='string' || normalizeModel(model)!==model) || !normalizeEffort(effort))throw failure();
  if(models.status==='ready'){
    const entry=models.list.find(entry=>entry.model===(model===null?preferredModel:model));
    if(model && !entry)throw failure();
    const efforts=model==='' || model===null && !entry?models.list.flatMap(entry=>entry.efforts):entry?.efforts || [];
    if(effort!=='auto' && !efforts.includes(effort))throw failure();
  }
}
module.exports={catalogView,panelDefaults,validateDefaults};
