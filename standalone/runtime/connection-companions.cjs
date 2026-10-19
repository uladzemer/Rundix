// Discover only installed extensions that explicitly depend on this extension.
// Account storage and authentication remain entirely with each provider.
async function activateCompanions(extensions, extensionId) {
  const companions=extensions.all.filter(extension=>extension.packageJSON?.extensionDependencies?.includes(extensionId));
  if(companions.length>16)throw Error('Too many connection companions.');
  for(const extension of companions) {
    let timer;
    try {
      await Promise.race([extension.activate(),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('Connection companion activation timed out.')),15000);
      })]);
    } finally {clearTimeout(timer);}
  }
}
module.exports={activateCompanions};
