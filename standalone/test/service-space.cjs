const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {resolveSpace, launchBinding} = require('../runtime/service-space.cjs');
const {canonical, reserve, acquire, release} = require('../runtime/task-directory.cjs');
const {SessionStore} = require('../runtime/store.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundix-space-synthetic-'));
function mkdir(relative) { const result = path.join(root, relative); fs.mkdirSync(result, {recursive:true}); return result; }
function linked(relative, gitdir, common) {
  const worktree = mkdir(relative);
  fs.mkdirSync(gitdir, {recursive:true});
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ' + path.relative(worktree, gitdir) + '\n');
  if (common) fs.writeFileSync(path.join(gitdir, 'commondir'), path.relative(gitdir, common) + '\n');
  return worktree;
}
try {
  const repo = mkdir('repo'), common = mkdir('repo/.git'), child = mkdir('repo/src/nested');
  const repoB = mkdir('repo-b'); mkdir('repo-b/.git');
  const nested = mkdir('repo/vendor/nested'); mkdir('repo/vendor/nested/.git');
  const worktree = linked('repo/.claude/worktrees/synthetic', path.join(common, 'worktrees/synthetic'), common);
  const external = linked('external-worktree', path.join(common, 'worktrees/external'), common);
  const separate = linked('separate', mkdir('separate-metadata'));
  const submodule = linked('repo/submodule', mkdir('repo/.git/modules/submodule'));
  const fakeClaude = mkdir('repo-b/.claude/worktrees/unlinked'); mkdir('repo-b/.claude/worktrees/unlinked/.git');
  const plain = mkdir('plain'), plainChild = mkdir('plain/sub');
  const a = resolveSpace(child), b = resolveSpace(repoB);
  assert.equal(a.root, canonical(repo)); assert.equal(a.kind, 'git');
  assert.equal(a.spaceId, createHash('sha256').update('rundix-space-v1\0' + process.platform + '\0git\0' + canonical(repo)).digest('hex'));
  assert.notEqual(a.spaceId, b.spaceId);
  for (const shared of [worktree, external]) assert.equal(resolveSpace(shared).spaceId, a.spaceId);
  for (const independent of [nested, separate, submodule, fakeClaude]) {
    assert.equal(resolveSpace(independent).root, canonical(independent));
    assert.notEqual(resolveSpace(independent).spaceId, a.spaceId);
  }
  // Same launch space, independent execution boundaries (D04 vs D08).
  const store = new SessionStore(mkdir('records'));
  reserve(store, repo, 'synthetic-main'); reserve(store, worktree, 'synthetic-worktree');
  assert.throws(() => acquire(store, child), /reserved/);
  acquire(store, worktree, 'synthetic-worktree')();
  release(store, repo, 'synthetic-main'); release(store, worktree, 'synthetic-worktree');
  assert.equal(resolveSpace(plain).kind, 'directory');
  assert.notEqual(resolveSpace(plain).spaceId, resolveSpace(plainChild).spaceId);
  assert.deepEqual(launchBinding({env:{CLAUDE_PROJECT_DIR:child}, cwd:repoB}),
    {launchDirectory:canonical(child), source:'claude_project_dir', ...a});
  for (const env of [{}, {CLAUDE_PROJECT_DIR:''}]) {
    const launch = launchBinding({env, cwd:repoB}); assert.equal(launch.source, 'cwd'); assert.equal(launch.spaceId, b.spaceId);
  }
  for (const invalid of ['relative', ' ', path.join(root, 'absent'), child + '\0', path.join(repo, '.git', 'HEAD')]) {
    assert.throws(() => launchBinding({env:{CLAUDE_PROJECT_DIR:invalid}, cwd:repoB}), {code:'space_invalid_directory'});
  }
  fs.writeFileSync(path.join(root, 'file'), 'synthetic');
  assert.throws(() => resolveSpace(path.join(root, 'file')), {code:'space_invalid_directory'});

  const invalidRepo = mkdir('invalid');
  for (const content of ['', 'not-gitdir', 'gitdir: one\ngitdir: two', 'gitdir: one\0', 'x'.repeat(4097), Buffer.from([0xff])]) {
    fs.writeFileSync(path.join(invalidRepo, '.git'), content);
    assert.throws(() => resolveSpace(invalidRepo), {code:'space_git_invalid'});
  }
  const target = mkdir('unusual-metadata'), unusual = linked('unusual', mkdir('unusual-entry'), target);
  assert.throws(() => resolveSpace(unusual), {code:'space_git_layout_unsupported'});
  fs.writeFileSync(path.join(target, 'commondir'), '.\n');
  assert.throws(() => resolveSpace(unusual), {code:'space_git_invalid'});
  const entry = mkdir('cycle-a'), cycleB = mkdir('cycle-b');
  const cycle = linked('cycle-worktree', entry, cycleB);
  fs.writeFileSync(path.join(cycleB, 'commondir'), path.relative(cycleB, entry));
  assert.throws(() => resolveSpace(cycle), {code:'space_git_invalid'});
  const deep = linked('deep-worktree', mkdir('hop-0'));
  for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(mkdir('hop-' + i), 'commondir'), path.relative(path.join(root, 'hop-' + i), mkdir('hop-' + (i + 1))));
  assert.throws(() => resolveSpace(deep), {code:'space_git_invalid'});
  fs.writeFileSync(path.join(root, 'hop-0', 'commondir'), 'first\nsecond');
  assert.throws(() => resolveSpace(deep), {code:'space_git_invalid'});

  // Permission errors and markers which are not files/directories fail closed.
  const originalLstat = fs.lstatSync;
  try {
    fs.lstatSync = file => {
      if (file === path.join(canonical(plain), '.git')) throw Object.assign(Error('synthetic-denied'), {code:'EACCES'});
      return originalLstat(file);
    };
    assert.throws(() => resolveSpace(plain), {code:'space_invalid_directory'});
  } finally { fs.lstatSync = originalLstat; }

  // Junctions need no Windows symlink privilege; elsewhere use a directory link.
  const alias = path.join(root, 'alias'); fs.symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(resolveSpace(alias).spaceId, a.spaceId);
  if (process.platform === 'win32') {
    assert.equal(resolveSpace(mkdir('globalroot')).kind, 'directory', 'Ordinary names are not device namespaces');
    assert.equal(canonical(repo.toUpperCase()), canonical(repo));
    assert.equal(canonical('\\\\?\\' + repo), canonical(repo));
    assert.equal(canonical(repo + '\\'), canonical(repo));
    for (const device of ['\\\\.\\C:\\', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\'])
      assert.throws(() => resolveSpace(device), {code:'space_invalid_directory'});
  }
  console.log('PASS service spaces: launch precedence, git/worktrees, nested/non-git isolation, bounded malformed metadata, canonical aliases.');
} finally {
  assert.equal(path.dirname(root), os.tmpdir());
  assert(path.basename(root).startsWith('rundix-space-synthetic-'));
  fs.rmSync(root, {recursive:true, force:true});
}
