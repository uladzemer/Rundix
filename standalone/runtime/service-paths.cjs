// One resolver for production defaults and explicitly isolated hosts.
const path = require('node:path');
const os = require('node:os');
function servicePaths({platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA,
  appData = process.env.APPDATA, root, pathEnv = process.env} = {}) {
  const defaultDirectory = platform === 'win32'
    ? path.join(localAppData || path.join(home,'AppData','Local'), 'Rundix','service')
    : platform === 'darwin' ? path.join(home,'Library','Application Support','Rundix','service')
      : path.join(home,'.local','state','Rundix','service');
  const userConfig = platform === 'win32' ? path.join(appData || path.join(home,'AppData','Roaming'),'Rundix')
    : platform === 'darwin' ? path.join(home,'Library','Application Support','Rundix') : path.join(home,'.config','Rundix');
  const directory = root || pathEnv.RUNDIX_SERVICE_ROOT;
  return {defaultDirectory, directory:directory ? path.resolve(directory) : defaultDirectory,
    providerConfig:path.join(pathEnv.RUNDIX_PROVIDER_CONFIG_DIR ? path.resolve(pathEnv.RUNDIX_PROVIDER_CONFIG_DIR) : path.join(userConfig,'rundix-service'), 'provider.json'),
    endpointNamespace:pathEnv.RUNDIX_SERVICE_ENDPOINT_NAMESPACE || ''};
}
module.exports = {servicePaths};
