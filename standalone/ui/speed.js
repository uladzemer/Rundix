(function(root){
 function fastTier(model){
  if(Array.isArray(model?.serviceTiers)){
   const tier=model.serviceTiers.find(t=>['fast','priority'].includes(t?.id));
   return tier?.id || null;
  }
  return model?.additionalSpeedTiers?.includes('fast') ? 'fast' : null;
 }
 function effectiveTier(model,enabled){return enabled ? fastTier(model) || 'default' : 'default';}
 const api={fastTier,effectiveTier};
 if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WorkbenchSpeed=api;
})(globalThis);
