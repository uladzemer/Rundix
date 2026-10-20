const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {isolate, assertUnchanged} = require('./test-isolation.cjs');
const {before} = isolate();
const host = process.argv[2] === '--host';
const tests = host ? [process.argv[3] || 'host.cjs'] : process.argv.slice(2);
if (!tests.length) tests.push(...require('../package.json').scripts['test:suites'].split(' && ').map(command => {
  if (!/^node test\/[\w-]+\.cjs$/.test(command)) throw Error('Unsupported test command');
  return command.slice(5);
}));
for (const test of tests) {
  console.log('RUN ' + test);
  const result = host ? spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'host.ps1'),'-TestFile',test,...process.argv.slice(4)],
    {stdio:'inherit',windowsHide:true,timeout:240000})
    : spawnSync(process.execPath,['--require',path.join(__dirname,'preload-isolation.cjs'),test],
      {stdio:'inherit',windowsHide:true,timeout:180000,cwd:path.join(__dirname,'..')});
  assertUnchanged(before);
  if (result.error || result.status !== 0) {console.error('Isolated test failed: ' + test);process.exitCode = 1;break;}
}
