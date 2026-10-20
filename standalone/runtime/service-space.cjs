// Stage-1 launch binding (D06-D09). No subprocesses, git config, roots/list or
// execution directory participates in space identity. Recompute at service hello.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {TextDecoder} = require('node:util');
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

function failure(code) { return Object.assign(Error(code), {code}); }
function directory(value) {
  try { return canonical(value); }
  catch { throw failure('space_invalid_directory'); }
}
function marker(file) {
  try { return fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure('space_invalid_directory');
  }
}
function line(file) {
  let fd;
  try {
    // Bound both allocation and read, including a file which grows after stat.
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw failure('space_git_invalid');
    const buffer = Buffer.alloc(4097);
    let size = 0, count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null))) size += count;
    if (size > 4096) throw failure('space_git_invalid');
    let value;
    try { value = new TextDecoder('utf-8', {fatal:true}).decode(buffer.subarray(0, size)); }
    catch { throw failure('space_git_invalid'); }
    value = value.replace(/\r?\n$/, '');
    if (!value || /[\r\n\0]/.test(value)) throw failure('space_git_invalid');
    return value;
  } catch (error) {
    if (error.code === 'space_git_invalid') throw error;
    throw failure('space_invalid_directory');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function gitRoot(worktree, gitMarker) {
  if (gitMarker.isDirectory()) return worktree;
  if (!gitMarker.isFile()) throw failure('space_git_invalid');
  const match = /^gitdir: (.+)$/.exec(line(path.join(worktree, '.git')));
  if (!match) throw failure('space_git_invalid');
  let gitdir = directory(path.resolve(worktree, match[1]));
  const seen = new Set([gitdir]);
  let linked = false;
  // A bounded chain also rejects malformed common-directory cycles. Normal git
  // layouts take one transition, including .claude and external worktrees.
  for (let hop = 0; hop <= 8; hop++) {
    const commonFile = path.join(gitdir, 'commondir');
    const common = marker(commonFile);
    if (!common) {
      if (!linked) return worktree; // submodule / separate-git-dir
      if (path.basename(gitdir) !== '.git') throw failure('space_git_layout_unsupported');
      return directory(path.dirname(gitdir));
    }
    if (hop === 8 || !common.isFile()) throw failure('space_git_invalid');
    if (!linked) {
      // A gitdir pointer alone cannot confer another repository's task space.
      const back = marker(path.join(gitdir, 'gitdir'));
      if (!back?.isFile()) throw failure('space_git_invalid');
      const pointed = path.resolve(gitdir, line(path.join(gitdir, 'gitdir')));
      const actual = path.join(worktree, '.git');
      let target;
      try {target = fs.realpathSync.native(pointed);} catch {throw failure('space_git_invalid');}
      const expected = fs.realpathSync.native(actual);
      if ((process.platform === 'win32' ? target.toLowerCase() : target) !==
          (process.platform === 'win32' ? expected.toLowerCase() : expected)) throw failure('space_git_invalid');
    }
    gitdir = directory(path.resolve(gitdir, line(commonFile)));
    if (seen.has(gitdir)) throw failure('space_git_invalid');
    seen.add(gitdir); linked = true;
  }
  throw failure('space_git_invalid');
}
function resolveSpace(launchDirectory) {
  const launch = directory(launchDirectory);
  let ancestor = launch;
  for (let depth = 0; depth < 256; depth++) {
    const gitMarker = marker(path.join(ancestor, '.git'));
    if (gitMarker) return binding('git', gitRoot(ancestor, gitMarker));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return binding('directory', launch);
    ancestor = parent;
  }
  throw failure('space_git_invalid');
}
function binding(kind, root) {
  return {kind, root, spaceId:createHash('sha256')
    .update('rundix-space-v1\0' + process.platform + '\0' + kind + '\0' + root).digest('hex')};
}
function launchBinding({env = process.env, cwd = process.cwd()} = {}) {
  const fromEnv = env.CLAUDE_PROJECT_DIR;
  // An invalid non-empty environment value must never choose a different repo.
  const source = fromEnv !== undefined && fromEnv !== '' ? 'claude_project_dir' : 'cwd';
  const launchDirectory = directory(source === 'cwd' ? cwd : fromEnv);
  return {launchDirectory, source, ...resolveSpace(launchDirectory)};
}
module.exports = {resolveSpace, launchBinding, canonical};
