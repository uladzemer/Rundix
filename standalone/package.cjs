const {spawnSync}=require('node:child_process');
const {version}=require('./package.json');
if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))throw Error('Invalid package version');
const result=spawnSync('npx',['--yes','@vscode/vsce@4.0.0','package','--allow-missing-repository',
  '--out',`rundix-${version}.vsix`,...process.argv.slice(2)],{
  cwd:__dirname,stdio:'inherit',shell:process.platform==='win32',
});
if(result.error)throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
let output = `rundix-${version}.vsix`;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' || args[i] === '-o') output = args[++i];
  else if (args[i].startsWith('--out=')) output = args[i].slice(6);
}
require('./test/package-audit.cjs').audit(require('node:path').resolve(__dirname, output));
