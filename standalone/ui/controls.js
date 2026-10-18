(function(root){
 const locale=typeof module!=='undefined'&&module.exports?require('./i18n.js'):root.WorkbenchI18n;
 const labels={none:'Выключено',minimal:'Минимальное',low:'Низкое',medium:'Среднее',high:'Высокое',xhigh:'Очень высокое',max:'Максимальное',ultra:'Предельное'};
 function levels(model){const order=['none','minimal','low','medium','high','xhigh','max','ultra'];return [...(model?.supportedReasoningEfforts||[])].sort((a,b)=>{const x=order.indexOf(a.reasoningEffort),y=order.indexOf(b.reasoningEffort);return (x<0?100:x)-(y<0?100:y);});}
 function context(state){const usage=state.tokenUsage,window=usage?.modelContextWindow,used=usage?.last?.totalTokens;if(state.usageStale||state.usageModel&&state.usageModel!==state.model||!Number.isFinite(window)||window<=0||!Number.isFinite(used)||used<0)return null;return {used,window,percent:Math.max(0,Math.min(100,used/window*100))};}
 // Retain row DOM, focus and running transitions when only state changes.
 function keyedRows(parent, items, renderRow) {
  const previous = new Map([...parent.children].map(node => [node.dataset.rowKey, node]));
  const retained = new Set();
  let next = parent.firstElementChild;
  for (const item of items) {
   const key = String(item[0]);
   const node = renderRow(item, previous.get(key));
   node.dataset.rowKey = key;
   retained.add(node);
   if (node !== next) parent.insertBefore(node, next);
   next = node.nextElementSibling;
  }
  for (const node of [...parent.children]) if (!retained.has(node)) node.remove();
 }
 const api={levels,context,keyedRows,label:value=>locale.t(labels[value]||value)};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WorkbenchControls=api;
})(globalThis);
