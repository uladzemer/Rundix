// A source-only development entry point isolates BEFORE extension activation.
const fs = require('node:fs'), path = require('node:path');
const source = fs.realpathSync.native(path.resolve(__dirname,'..'));
function prepareHost(directory, testFile) {
  fs.mkdirSync(directory,{recursive:true});
  const manifest = {...require('../package.json'),main:'./entry.cjs',activationEvents:[]};
  fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify(manifest));
  for (const file of ['package.nls.json','package.nls.ru.json']) fs.copyFileSync(path.join(source,file),path.join(directory,file));
  for (const dir of ['ui','resources']) fs.cpSync(path.join(source,dir),path.join(directory,dir),{recursive:true});
  fs.writeFileSync(path.join(directory,'entry.cjs'),
    `const path=require('node:path'),{createRequire}=require('node:module');\n` +
    `const testFile=${JSON.stringify(testFile)};\n` +
    `const testKey=Object.keys(require.cache).find(key=>process.platform==='win32'?key.toLowerCase()===testFile.toLowerCase():key===testFile);\n` +
    `if(!testKey)throw Error('Source test entry must load before extension activation');\n` +
    `const load=createRequire(testKey);\n` +
    `load('./test-isolation.cjs').isolate();\n` +
    `exports.activate=context=>load('../extension.cjs').activate(context);\n`);


}
if (require.main === module) prepareHost(process.argv[2],process.argv[3]);
module.exports = {prepareHost};
