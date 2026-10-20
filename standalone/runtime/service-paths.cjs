// Production resolver. Test isolation is injected by source-tree test helpers only.
const path = require('node:path');
const os = require('node:os');
function servicePaths({platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA,
  appData = process.env.APPDATA, root} = {}) {
  const defaultDirectory = platform === 'win32'
    ? path.join(localAppData || path.join(home,'AppData','Local'), 'Rundix','service')
    : platform === 'darwin' ? path.join(home,'Library','Application Support','Rundix','service')
      : path.join(home,'.local','state','Rundix','service');
  const userConfig = platform === 'win32' ? path.join(appData || path.join(home,'AppData','Roaming'),'Rundix')
    : platform === 'darwin' ? path.join(home,'Library','Application Support','Rundix') : path.join(home,'.config','Rundix');
  const directory = root;
  return {defaultDirectory, directory:directory ? path.resolve(directory) : defaultDirectory,
    providerConfig:path.join(userConfig,'rundix-service','provider.json'),
    endpointNamespace:''};
}
module.exports = {servicePaths};
