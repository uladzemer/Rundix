// Git operations never invoke a shell or expose raw git output (which can contain paths).
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {execFile} = require('node:child_process');
const BUSY = 'Папка занята другим чатом. Не удалось создать worktree. Черновик сохранён.';
const WAIT = 'Дождитесь завершения другого чата в основной папке.';
const GONE = 'Worktree больше не существует.';
const IGNORED = 'Игнорируемые файлы в нём (сборка, зависимости) тоже будут удалены.';
const MOVE_FAILED = 'Не удалось создать worktree: {0}. Черновик сохранён.';
const MAX_FILES = 20000, MAX_BYTES = 512*1024*1024;
const IN_WORKTREES = /[\\/]\.rundix[\\/]worktrees[\\/]/;
function git(cwd, args) {
  // Windows also looks for git.exe in the child's cwd; never start it inside the repository.
  return new Promise((resolve, reject) => execFile('git', ['-C', cwd, ...args], {cwd:__dirname, timeout:60000, maxBuffer:16*1024*1024, windowsHide:true}, (error, stdout, stderr) => {
    if(error) reject(Object.assign(Error('Git operation failed.'), {gitFailure:true, reason:error.killed?'timeout':reason(stderr+'\n'+stdout), exitCode:error.code}));
    else resolve(stdout.replace(/\r?\n$/, ''));
  }));
}
function reason(stderr='') {
  // Only categorical reasons are safe to present: stderr may include file names and chat text.
  if(/CONFLICT|conflict/i.test(stderr)) return 'conflict';
  if(/overwritten|local changes/i.test(stderr)) return 'localChanges';
  if(/identity|user.email|user.name/i.test(stderr)) return 'identity';
  if(/timed out/i.test(stderr)) return 'timeout';
  return 'git';
}
function inside(root, target) {
  const relative=path.relative(root,target);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Invalid worktree path.');
  return relative;
}
async function mkdirInside(root,directory) {
  const relative=inside(root,directory);
  let current=root;
  for(const part of relative.split(path.sep).filter(Boolean)) {
    current=path.join(current,part);
    const info=await fs.lstat(current).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(info && (info.isSymbolicLink() || !info.isDirectory()))throw Error('Unsafe copy destination.');
    if(!info)await fs.mkdir(current);
  }
}
async function exclude(common) {
  const file=path.join(common,'info','exclude');
  await fs.mkdir(path.dirname(file),{recursive:true});
  const lock=file+'.rundix-lock', deadline=Date.now()+3000;
  let handle;
  while(!handle) {
    try {handle=await fs.open(lock,'wx');}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      // A lock left by a killed host is older than any live append.
      const stale=await fs.stat(lock).then(info=>Date.now()-info.mtimeMs>30000,()=>false);
      if(stale){await fs.unlink(lock).catch(()=>{});continue;}
      if(Date.now()>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,30));
    }
  }
  try {
    const content=await fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
    if(!content.split(/\r?\n/).includes('/.rundix/'))await fs.appendFile(file,(content&&!content.endsWith('\n')?'\n':'')+'/.rundix/\n');
  }finally{await handle.close();await fs.unlink(lock);}
}
async function create(cwd, name) {
  cwd=await fs.realpath(cwd);
  // Not a repository (or no git at all): nothing can be isolated, the folder is simply busy.
  const top=await git(cwd,['rev-parse','--show-toplevel']).then(fs.realpath,()=>{throw Object.assign(Error('Not a repository.'),{notRepo:true});});
  const common=path.resolve(top,await git(top,['rev-parse','--git-common-dir']));
  const listing=await git(top,['worktree','list','--porcelain','-z']);
  const primary=await fs.realpath(listing.split('\0')[0].replace(/^worktree /,''));
  // A Rundix tree may have originated in another linked checkout, not only primary.
  const isRundix=path.basename(path.dirname(top))==='worktrees' && path.basename(path.dirname(path.dirname(top)))==='.rundix';
  const mainPath=isRundix?primary:top;
  const relative=inside(top,cwd);
  const slug=(String(name||'chat').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||'chat')+'-'+randomBytes(6).toString('hex');
  const branch='rundix/'+slug, target=path.join(mainPath,'.rundix','worktrees',slug);
  await exclude(common);
  for(const directory of [path.join(mainPath,'.rundix'),path.dirname(target)]) {
    const info=await fs.lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(info?.isSymbolicLink())throw Error('Invalid worktree directory.');
    await fs.mkdir(directory,{recursive:true});
  }
  // Do not follow a pre-existing .rundix symlink outside the repository.
  inside(await fs.realpath(mainPath),await fs.realpath(path.dirname(target)));
  const mainBranch=await git(mainPath,['branch','--show-current']);
  let added=false, attempted=false;
  try {
    const stash=await git(mainPath,['stash','create']);
    // Entries ending in '/' are nested repositories; only files are copied.
    const untracked=(await git(mainPath,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(file=>file && !file.endsWith('/'));
    if(untracked.length>MAX_FILES)throw Object.assign(Error('Too many untracked files.'),{reason:'limit'});
    let bytes=0;
    for(const file of untracked) {
      const info=await fs.lstat(path.resolve(mainPath,file)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(info?.isFile() && (bytes+=info.size)>MAX_BYTES)throw Object.assign(Error('Untracked files are too large.'),{reason:'limit'});
    }
    const branchExists=await git(mainPath,['show-ref','--verify','--quiet','refs/heads/'+branch]).then(()=>true,()=>false);
    if(branchExists)throw Error('Worktree branch already exists.');
    attempted=true;
    await git(mainPath,['worktree','add','-b',branch,target,'HEAD']);added=true;
    if(stash)await git(target,['stash','apply',stash]);
    for(const file of untracked) {
      const source=path.resolve(mainPath,file), destination=path.resolve(target,file);
      inside(mainPath,source);inside(target,destination);
      const info=await fs.lstat(source).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(!info || info.isDirectory())continue;
      inside(await fs.realpath(mainPath),await fs.realpath(path.dirname(source)));
      await mkdirInside(target,path.dirname(destination));
      inside(await fs.realpath(target),await fs.realpath(path.dirname(destination)));
      await fs.cp(source,destination,{dereference:false,verbatimSymlinks:true,force:false,errorOnExist:true});
    }
    // A folder that is untracked or empty at HEAD does not exist in the new checkout yet.
    const newCwd=path.join(target,relative);
    await mkdirInside(target,newCwd);
    // Keep the copied changes as one commit; without an identity they stay uncommitted.
    if(await git(target,['status','--porcelain'])) {
      try {await git(target,['add','-A']);await git(target,['-c','commit.gpgsign=false','commit','--no-verify','-m','Rundix: snapshot of uncommitted changes']);}
      catch {await git(target,['reset','-q']).catch(()=>{});}
    }
    return {worktree:{path:target,branch,mainPath,mainBranch,mainCwd:path.join(mainPath,relative)},cwd:newCwd};
  } catch(error) {
    if(added) {
      await git(mainPath,['worktree','remove','--force',target]);
      await git(mainPath,['branch','-D',branch]);
    }else if(attempted) {
      // A checkout hook/timeout may fail after git registered the worktree.
      const registered=await git(mainPath,['worktree','list','--porcelain','-z']);
      if(registered.split('\0').some(field=>field==='worktree '+target.replace(/\\/g,'/')))await git(mainPath,['worktree','remove','--force',target]);
      const exists=await git(mainPath,['show-ref','--verify','--quiet','refs/heads/'+branch]).then(()=>true,()=>false);
      if(exists)await git(mainPath,['branch','-D',branch]);
    }
    throw error;
  }
}
function busy(error) {return ['SESSION_BUSY','DIRECTORY_BUSY','DIRECTORY_RESERVED'].includes(error?.code);}
async function acquire(deps,s,cwd,options={}) {
  try {return deps.taskDirectory.acquire(deps.store,cwd,options.taskId);}
  catch(error) {
    if(options.taskId || options.projectDirectory || s.mcpTask || !busy(error))throw error;
    // The caller defers the move until the send is otherwise valid; it asks again later.
    if(options.defer)return null;
    let moved;
    try {moved=await create(cwd,s.name);}
    catch(failed) {
      if(failed.notRepo)throw Error(deps.locale.t(BUSY));
      const reasons={limit:'слишком много или слишком большие неотслеживаемые файлы',timeout:'истекло время ожидания Git',git:'ошибка Git'};
      const why=failed.gitFailure?(failed.reason==='timeout'?'timeout':'git'):failed.reason==='limit'?'limit':null;
      throw Error(deps.locale.t(MOVE_FAILED,deps.locale.t(why?reasons[why]:'ошибка файловой системы')));
    }
    let release;
    try {release=deps.taskDirectory.acquire(deps.store,moved.cwd);}
    catch {throw Error(deps.locale.t(BUSY));}
    s.worktree=moved.worktree;s.cwd=moved.cwd;s.cwdOverride=moved.cwd;
    // Persist before any RPC; a failed send still owns its isolated directory.
    try {await deps.save(s);deps.publish(s);return release;}
    catch(error){release();throw error;}
  }
}
function shape(w) {
  if(!w || !/^rundix\/[a-zA-Z0-9-]{1,60}$/.test(w.branch))throw Error('Invalid worktree.');
  if(path.resolve(w.path)!==path.join(path.resolve(w.mainPath),'.rundix','worktrees',w.branch.slice(7)))throw Error('Invalid worktree.');
  inside(w.mainPath,w.mainCwd || w.mainPath);
}
const listed=(listing,target)=>listing.split('\0').some(field=>field==='worktree '+target.replace(/\\/g,'/') || field==='worktree '+target);
async function validate(w) {
  shape(w);
  if(!listed(await git(w.mainPath,['worktree','list','--porcelain','-z']),w.path))throw Error('Worktree unavailable.');
  if(await git(w.path,['branch','--show-current'])!==w.branch)throw Error('Worktree branch changed.');
}
// Only ENOENT means deleted: a locked or offline drive must keep the record and its unmerged branch.
function missing(target) {return fs.access(target).then(()=>false,error=>error.code==='ENOENT');}
// The directory was deleted or pruned outside Rundix. A git failure alone never says "gone".
async function gone(w) {
  shape(w);
  if(await missing(w.path))return true;
  const listing=await git(w.mainPath,['worktree','list','--porcelain','-z']).catch(()=>null);
  return listing!==null && !listed(listing,w.path);
}
async function leave(deps,s,w) {
  // Back to the folder the chat came from, or the workspace if that is gone too.
  let back=w?.mainCwd || w?.mainPath;
  if(!back || !await fs.access(back).then(()=>true,()=>false))back=deps.cwd?.() || back;
  s.cwd=back;s.cwdOverride=back;s.worktree=null;
  await deps.save(s);
}
// Called before a send or fork: a chat must never stay stuck in a missing worktree directory.
async function recover(deps,s) {
  if(s.worktree) {
    if(await gone(s.worktree).catch(()=>false)){await leave(deps,s,s.worktree);deps.publish?.(s);return true;}
  }else if(s.cwd && IN_WORKTREES.test(s.cwd) && await missing(s.cwd)) {
    // A fork inherits the worktree cwd without its record.
    await leave(deps,s,null);deps.publish?.(s);return true;
  }
  return false;
}
async function merged(w) {
  try {await git(w.mainPath,['merge-base','--is-ancestor',w.branch,'HEAD']);return true;}
  catch(error){if(error.exitCode===1)return false;throw error;}
}
async function merge(w,name) {
  await validate(w);
  if(await git(w.mainPath,['rev-parse','--verify','-q','MERGE_HEAD']).then(()=>true,()=>false))throw Object.assign(Error('Existing merge.'),{reason:'localChanges'});
  // Never land the work on a branch the main folder switched to after the move.
  if(w.mainBranch && await git(w.mainPath,['branch','--show-current'])!==w.mainBranch)throw Object.assign(Error('Main branch changed.'),{reason:'branchChanged'});
  if(await git(w.path,['status','--porcelain'])) {
    await git(w.path,['add','-A']);
    await git(w.path,['commit','-m',String(name||'Rundix')]);
  }
  try {await git(w.mainPath,['merge','--no-ff','--no-edit',w.branch]);}
  catch(error) {
    const inProgress=await git(w.mainPath,['rev-parse','--verify','-q','MERGE_HEAD']).then(()=>true,()=>false);
    if(inProgress)await git(w.mainPath,['merge','--abort']);
    throw error;
  }
}
async function remove(w) {
  await validate(w);
  await git(w.mainPath,['worktree','remove','--force',w.path]);
  try {await git(w.mainPath,['branch','-D',w.branch]);}
  catch(error){error.worktreeRemoved=true;throw error;}
}
function failure(locale,error) {
  const reasons={conflict:'Конфликт слияния.',localChanges:'В основной папке есть незакоммиченные изменения. Закоммитьте или уберите их и повторите.',identity:'Настройте имя и email Git.',branchChanged:'Основная папка переключена на другую ветку. Вернитесь на исходную ветку и повторите.',timeout:'Истекло время ожидания Git.',git:'Git отказал в операции.'};
  return locale.t('Не удалось выполнить операцию worktree: {0}',locale.t(reasons[error.reason]||reasons.git));
}
async function dirty(w) {return !!(await git(w.path,['status','--porcelain']));}
async function operate(deps,s,action) {
  if(!['mergeWorktree','removeWorktree'].includes(action))throw Error('Invalid worktree action.');
  if(s.busy || s.compacting || s.sendingTask || s.followUpSending || s.worktreeBusy || s.mcpTask || !s.worktree)throw Error(deps.locale.t('Дождитесь завершения задачи.'));
  s.worktreeBusy=true;deps.publish(s);
  const w=s.worktree;
  let release,releaseMain,releaseSession,missing;
  try {
    try {
      releaseSession=deps.store.acquire(s.id || s.key);
      // A missing directory cannot be leased; there is nothing running in it.
      missing=await gone(w);
      if(!missing)release=deps.taskDirectory.acquire(deps.store,w.path);
      if(action==='mergeWorktree' && !missing)releaseMain=deps.taskDirectory.acquire(deps.store,w.mainPath);
    }catch(error){if(busy(error))throw Object.assign(Error(deps.locale.t(WAIT)),{localized:true});throw error;}
    if(action==='mergeWorktree'){
      if(missing)throw Object.assign(Error(deps.locale.t(GONE)),{localized:true});
      await merge(w,s.name);
      deps.info(deps.locale.t('Worktree влит в основную ветку.'));
    }else if(missing) {
      await git(w.mainPath,['worktree','prune']);
      const exists=await git(w.mainPath,['show-ref','--verify','--quiet','refs/heads/'+w.branch]).then(()=>true,()=>false);
      const unmerged=exists && !(await merged(w));
      if(!await deps.confirmRemove(deps.locale.t(unmerged?'Удалить worktree? Невлитые изменения будут потеряны.':'Удалить worktree?')))return;
      if(exists)await git(w.mainPath,['branch','-D',w.branch]);
      await leave(deps,s,w);
    }else{
      await validate(w);
      const unmerged=!(await merged(w)) || await dirty(w);
      if(!await deps.confirmRemove(deps.locale.t(unmerged?'Удалить worktree? Невлитые изменения будут потеряны.':'Удалить worktree?')+' '+deps.locale.t(IGNORED)))return;
      try {await remove(w);}
      catch(error){
        // Git may remove the tree but refuse to delete its ref. Keep the chat usable.
        if(error.worktreeRemoved){s.cwd=w.mainCwd || w.mainPath;s.cwdOverride=s.cwd;s.worktree=null;await deps.save(s);}
        throw error;
      }
      s.cwd=w.mainCwd || w.mainPath;s.cwdOverride=s.cwd;s.worktree=null;
      await deps.save(s);
    }
  }catch(error){throw error.localized ? error : Error(failure(deps.locale,error));}
  finally {releaseMain?.();release?.();releaseSession?.();s.worktreeBusy=false;deps.publish(s);}
}
module.exports={operate,dirty,create,acquire,recover,gone,merge,remove,merged,validate,failure,BUSY,WAIT,GONE,IGNORED};
