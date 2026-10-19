const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

function canonical(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw Error('projectDirectory must be absolute.');
  const real = fs.realpathSync.native(directory);
  if (!fs.statSync(real).isDirectory()) throw Error('Project directory is unavailable.');
  return process.platform === 'win32' ? real.toLowerCase() : real;
}
function key(directory) { return createHash('sha256').update(canonical(directory)).digest('hex'); }
function assertAvailable(store, directory, taskId) {
  const id=key(directory), owner = store.read('task-directory', id);
  if(fs.existsSync(store.file('task-directory',id)) && (!owner || typeof owner.taskId!=='string'))throw Error('Project directory reservation is unreadable.');
  if (owner && owner.taskId !== taskId) throw Error('Project directory is reserved by another MCP task.');
}
function reserve(store, directory, taskId) {
  const id = key(directory), release = store.acquire('directory-' + id);
  try {
    assertAvailable(store, directory, taskId);
    store.write('task-directory', id, {taskId});
  } finally { release(); }
}
function release(store, directory, taskId) {
  const id = key(directory);
  if (store.read('task-directory', id)?.taskId === taskId) fs.unlinkSync(store.file('task-directory', id));
}
function acquire(store, directory, taskId) {
  const unlock = store.acquire('directory-' + key(directory));
  try { assertAvailable(store, directory, taskId); return unlock; }
  catch (error) { unlock(); throw error; }
}
module.exports = {canonical, reserve, release, acquire};
