const fs = require('node:fs');
const path = require('node:path');
const {parseStrict} = require('./service-json.cjs');

function versionParts(value) {
  if (typeof value !== 'string' || value.length > 48 || !/^\d+\.\d+\.\d+$/.test(value)) return null;
  return value.split('.').map(part => BigInt(part));
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) return null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function manifest(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw Error('Invalid service manifest');
  return parseStrict(fs.readFileSync(file));
}

function restartTarget(root) {
  try {
    const installed = require('./service-launcher.cjs').registration(root);
    if (!versionParts(installed.version)) return null;
    const versions = fs.realpathSync(path.join(root, 'versions'));
    if (path.dirname(versions) !== fs.realpathSync(root) || path.basename(versions) !== 'versions') return null;
    const entry = fs.realpathSync(installed.entryPath), adapter = fs.realpathSync(installed.adapterPath);
    const copy = path.dirname(path.dirname(entry));
    if (path.dirname(copy) !== versions || path.dirname(path.dirname(adapter)) !== copy ||
        path.basename(path.dirname(entry)) !== 'runtime' || path.basename(path.dirname(adapter)) !== 'runtime' ||
        manifest(path.join(copy, 'complete.json')).version !== installed.version ||
        manifest(path.join(copy, 'package.json')).version !== installed.version) return null;
    return installed;
  } catch { return null; }
}

function handoverTarget(root, runningVersion) {
  const installed = restartTarget(root);
  return compareVersions(installed?.version, runningVersion) === 1 ? installed : null;
}

module.exports = {compareVersions, handoverTarget, restartTarget};
