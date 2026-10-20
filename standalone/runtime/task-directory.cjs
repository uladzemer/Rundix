const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

function canonical(directory) {
  if (typeof directory !== 'string' || directory.includes('\0') || !path.isAbsolute(directory)) throw Error('projectDirectory must be absolute.');
  if (process.platform === 'win32' && (/^\\\\\.\\/.test(directory) || /^\\\\\?\\globalroot(?:\\|$)/i.test(directory)))
    throw Error('Device directories are unsupported.');
  const real = fs.realpathSync.native(directory);
  if (!fs.statSync(real).isDirectory()) throw Error('Project directory is unavailable.');
  if (process.platform !== 'win32') return path.normalize(real);
  // DOS/UNC extended prefixes name the same directory and must hash identically.
  const plain = real.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
  const normalized = path.win32.normalize(plain);
  const root = path.win32.parse(normalized).root;
  return (normalized.length > root.length ? normalized.replace(/\\+$/, '') : normalized).toLowerCase();
}
function key(directory) {
  const real = canonical(directory);
  for (let ancestor = real;; ancestor = path.dirname(ancestor)) {
    try {
      // A nested worktree's .git file establishes its own reservation boundary.
      fs.lstatSync(path.join(ancestor, '.git'));
      return createHash('sha256').update(ancestor).digest('hex');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(ancestor) === ancestor) break;
  }
  return createHash('sha256').update(real).digest('hex');
}
function assertAvailable(store, id, taskId) {
  const owner = store.read('task-directory', id);
  if(fs.existsSync(store.file('task-directory',id)) && (!owner || typeof owner.taskId!=='string'))throw Error('Project directory reservation is unreadable.');
  if (owner && owner.taskId !== taskId) throw Error('Project directory is reserved by another MCP task.');
}
function reserve(store, directory, taskId) {
  const id = key(directory), release = store.acquire('directory-' + id);
  try {
    assertAvailable(store, id, taskId);
    store.write('task-directory', id, {taskId});
  } finally { release(); }
}
function release(store, directory, taskId) {
  if (typeof taskId !== 'string') return;
  // The persisted filename already holds the reservation key. Search by owner,
  // including legacy {taskId} records, without accessing the project directory.
  for (const name of fs.readdirSync(store.directory)) {
    const match = /^task-directory-([a-f0-9]{64})\.json$/.exec(name);
    if (!match) continue;
    // Another owner's record may be mid-rename on Windows; it is never ours to release.
    let owner;
    try { owner = store.read('task-directory', match[1]); } catch { continue; }
    if (owner?.taskId !== taskId) continue;
    try { fs.unlinkSync(store.file('task-directory', match[1])); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function acquire(store, directory, taskId) {
  const id = key(directory), unlock = store.acquire('directory-' + id);
  try { assertAvailable(store, id, taskId); return unlock; }
  catch (error) { unlock(); throw error; }
}
module.exports = {canonical, reserve, release, acquire};
