const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {SessionStore} = require('../runtime/store.cjs');
const {canonical, reserve, release, acquire} = require('../runtime/task-directory.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-directory-synthetic-'));
try {
  const store = new SessionStore(path.join(root, 'records'));
  const repo = path.join(root, 'synthetic-repo'), child = path.join(repo, 'src', 'nested');
  const worktree = path.join(repo, 'synthetic-worktree'), worktreeChild = path.join(worktree, 'src');
  fs.mkdirSync(child, {recursive: true});
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(worktreeChild, {recursive: true});
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: synthetic-gitdir\n');
  assert.notEqual(canonical(repo), canonical(child), 'Canonical cwd remains exact');

  reserve(store, repo, 'synthetic-parent');
  const legacyReal=fs.realpathSync.native(repo), legacyReservationKey=createHash('sha256').update(process.platform==='win32'?legacyReal.toLowerCase():legacyReal).digest('hex');
  assert.equal(store.read('task-directory',legacyReservationKey).taskId,'synthetic-parent','Reservation filename keeps the 0.3.1 key');
  assert.throws(() => reserve(store, child, 'synthetic-child'), /reserved/);
  assert.throws(() => acquire(store, child), /reserved/, 'Chat in subfolder conflicts with parent task');
  acquire(store, child, 'synthetic-parent')();
  reserve(store, worktreeChild, 'synthetic-worktree');
  assert.throws(() => acquire(store, worktree), /reserved/);
  acquire(store, worktreeChild, 'synthetic-worktree')();
  release(store, repo, 'synthetic-parent');
  const chatLease = acquire(store, child);
  assert.throws(() => reserve(store, repo, 'synthetic-parent'), 'Active subfolder chat blocks parent task');
  chatLease();
  reserve(store, child, 'synthetic-child');
  assert.throws(() => acquire(store, repo), /reserved/, 'Nested task blocks parent chat');
  release(store, child, 'synthetic-child');
  release(store, worktreeChild, 'synthetic-worktree');

  const plain = path.join(root, 'synthetic-plain'), plainChild = path.join(plain, 'child');
  fs.mkdirSync(plainChild, {recursive: true});
  reserve(store, plain, 'synthetic-plain');
  acquire(store, plainChild)(); // Non-git directories keep their exact boundary.
  release(store, plain, 'synthetic-plain');

  reserve(store, child, 'synthetic-deleted');
  const moved = path.join(root, 'synthetic-moved');
  fs.renameSync(repo, moved);
  release(store, child, 'synthetic-deleted');
  acquire(store, moved)();
  reserve(store, moved, 'synthetic-removed');
  fs.rmSync(moved, {recursive: true});
  assert.doesNotThrow(() => release(store, moved, 'synthetic-removed'));
  assert(!fs.readdirSync(store.directory).some(name => name.startsWith('task-directory-')));

  // Legacy filenames used a hash of the exact cwd, including subdirectories.
  const legacyKey = createHash('sha256').update(canonical(plainChild)).digest('hex');
  store.write('task-directory', legacyKey, {taskId: 'synthetic-legacy'});
  reserve(store, plain, 'synthetic-survivor');
  release(store, plainChild, 'synthetic-unknown');
  assert.equal(store.read('task-directory', legacyKey).taskId, 'synthetic-legacy');
  release(store, plainChild, 'synthetic-legacy');
  assert.equal(store.read('task-directory', legacyKey), null);
  assert.throws(() => acquire(store, plain), /reserved/, 'Release preserves other owners');
  release(store, plain, 'synthetic-survivor');

  reserve(store, plain, 'synthetic-no-project-io');
  const realpath = fs.realpathSync.native, stat = fs.statSync, lstat = fs.lstatSync;
  try {
    fs.realpathSync.native = fs.statSync = fs.lstatSync = () => { throw Error('Unexpected project lookup'); };
    release(store, plain, 'synthetic-no-project-io');
    release(store, path.join(root, 'synthetic-missing'), 'synthetic-unknown');
  } finally { fs.realpathSync.native = realpath; fs.statSync = stat; fs.lstatSync = lstat; }
  acquire(store, plain)();
  console.log('Task directory: nested conflicts, independent worktrees, exact non-git cwd, deletion/rename, disk-free release and legacy records passed.');
} finally { fs.rmSync(root, {recursive: true, force: true}); }
