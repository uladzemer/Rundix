const fs = require('node:fs'), path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {install} = require('./service-provider-fixture.cjs');
const {ServiceAppServer} = require('../runtime/service-cli.cjs');
function fixture(root, {installed = install(root), observeCli = () => {}} = {}) {
  const children = [];
  const launch = (exe, argv, options) => {
    const child = spawn(exe, argv, options); children.push({child, closed:once(child, 'close')}); return child;
  };
  const hostOptions = {resolveCli:async () => process.execPath, providerOptions:{configPath:installed.configPath,
    verifyPrivate:() => {}, spawnProcess:launch, createCli:options => new ServiceAppServer({...options,
      spawnProcess:(_exe, argv, childOptions) => {
        if (!argv.includes('cli_auth_credentials_store="ephemeral"')) throw Error('Missing ephemeral config');
        observeCli({ephemeral:true});
        return launch(process.execPath, [path.join(__dirname, 'fake-headless-cli.cjs')], childOptions);
      }})}};
  return {installed, hostOptions, children, async close() {
    for (const value of children) value.child.kill(); await Promise.allSettled(children.map(value => value.closed));
  }};
}
module.exports = {fixture};
