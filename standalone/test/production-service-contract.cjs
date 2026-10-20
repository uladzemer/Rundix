// Execute actual distributed source with hostile project environment, without I/O.
const assert = require('node:assert/strict'), path = require('node:path'), vm = require('node:vm');
function validatePaths(source) {
  assert(!/RUNDIX_|pathEnv|test-isolation/.test(source),'Production paths must contain no test override reader or loader');
  const synthetic = path.resolve('synthetic-production-contract');
  const values = {LOCALAPPDATA:path.join(synthetic,'local'),APPDATA:path.join(synthetic,'roaming'),
    RUNDIX_SERVICE_ROOT:path.join(synthetic,'attacker-service'),RUNDIX_PROVIDER_CONFIG_DIR:path.join(synthetic,'attacker-provider'),
    RUNDIX_SERVICE_ENDPOINT_NAMESPACE:'attacker',RUNDIX_TEST_ISOLATED:'1'};
  const env = new Proxy(values,{get(target,key) {
    if (/^RUNDIX_/i.test(String(key))) assert.fail('Production resolver read a project-controlled override');
    return target[key];
  }});
  const output = {exports:{}};
  vm.runInNewContext(source,{module:output,process:{platform:'win32',env},require(name) {
    if (name === 'node:path') return path;
    if (name === 'node:os') return {homedir:()=>synthetic};
    assert.fail('Unexpected production resolver dependency');
  }},{timeout:1000});
  const resolved = output.exports.servicePaths();
  assert.equal(resolved.directory,path.join(values.LOCALAPPDATA,'Rundix','service'));
  assert.equal(resolved.providerConfig,path.join(values.APPDATA,'Rundix','rundix-service','provider.json'));
  assert.equal(resolved.endpointNamespace,'');
  assert.equal(output.exports.servicePaths({root:synthetic}).directory,synthetic);
}
function validateEnvironment(source) {
  const output = {exports:{}};
  vm.runInNewContext(source,{module:output},{timeout:1000});
  const hostile = {PATH:'synthetic',RUNDIX_SERVICE_ROOT:'synthetic',RUNDIX_PROVIDER_CONFIG_DIR:'synthetic',
    RUNDIX_SERVICE_ENDPOINT_NAMESPACE:'synthetic',RUNDIX_TEST_ISOLATED:'1',RUNDIX_UNKNOWN:'synthetic',rundix_service_root:'synthetic'};
  const clean = output.exports.serviceEnvironment(hostile);
  assert.equal(clean.PATH,'synthetic');
  assert(!Object.keys(clean).some(key=>/^RUNDIX_/i.test(key)),'Service spawn environment must strip every RUNDIX_* key');
}
module.exports = {validatePaths,validateEnvironment};
