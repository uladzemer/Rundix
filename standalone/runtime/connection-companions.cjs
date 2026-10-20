// Discover only installed extensions that explicitly depend on this extension.
// Account storage and authentication remain entirely with each provider.
async function activateOwner(activate, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(activate), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Connection companion activation timed out. Choose Local Codex CLI or retry.')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
async function activateCompanions(extensions, extensionId) {
  const companions=extensions.all.filter(extension=>extension.packageJSON?.extensionDependencies?.includes(extensionId));
  if(companions.length>16)throw Error('Too many connection companions.');
  for(const extension of companions) {
    await activateOwner(() => extension.activate());
  }
}
module.exports={activateCompanions, activateOwner};
