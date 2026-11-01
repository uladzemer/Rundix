// Only synthetic repositories, identities and chat records.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const worktrees=require('../runtime/chat-worktrees.cjs');
const directories=require('../runtime/task-directory.cjs');
const {SessionStore}=require('../runtime/store.cjs');
const git=(cwd,args)=>new Promise((resolve,reject)=>execFile('git',args,{cwd,timeout:60000,windowsHide:true},(error,stdout)=>error?reject(Error('Synthetic git failed')):resolve(stdout.trim())));
async function repo(root,name){
  const cwd=path.join(root,name);await fs.mkdir(path.join(cwd,'sub'),{recursive:true});
  await git(cwd,['init','-b','main']);
  await git(cwd,['config','core.autocrlf','false']);
  await git(cwd,['config','commit.gpgsign','false']);
  await git(cwd,['config','core.hooksPath',path.join(cwd,'.git','synthetic-empty-hooks')]);
  await git(cwd,['config','user.name','Synthetic Tester']);await git(cwd,['config','user.email','synthetic@example.invalid']);
  await fs.writeFile(path.join(cwd,'tracked.txt'),'synthetic base\n');await fs.writeFile(path.join(cwd,'sub','file.txt'),'synthetic subfolder\n');
  await git(cwd,['add','.']);await git(cwd,['commit','-m','Synthetic base']);return fs.realpath(cwd);
}
async function run(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rundix-synthetic-worktrees-'));
  try{
    const main=await repo(root,'main'), store=new SessionStore(path.join(root,'store'));
    let saves=0;
    const deps={taskDirectory:directories,store,locale:{t:(s,...a)=>s.replace(/\{(\d)\}/g,(_,i)=>a[i])},save:async()=>saves++,publish(){}};
    // Legacy records omit these fields: an unrelated stale-window save must not clear a new move.
    {
      const save=require('../runtime/session-persistence.cjs').save;
      const persistence={store,workspaceState:{update:async()=>{}}};
      const writer={key:'synthetic-stale-window',cwd:main,items:[],prefs:{},draft:'Synthetic original'};
      await save(persistence,writer);
      const stale=JSON.parse(JSON.stringify(writer));
      writer.cwd=path.join(main,'synthetic-isolated');writer.cwdOverride=writer.cwd;
      writer.worktree={path:writer.cwd,branch:'rundix/synthetic-stale-window',mainPath:main};
      await save(persistence,writer);
      stale.draft='Synthetic newer draft';await save(persistence,stale);
      assert.deepEqual(store.session(writer.key).worktree,writer.worktree);
      assert.equal(store.session(writer.key).cwdOverride,writer.cwdOverride);
      assert.deepEqual(stale.worktree,writer.worktree);
    }
    const s={name:'Synthetic ../../ chat',cwd:main};
    const beforeHead=await git(main,['rev-parse','HEAD']);
    await fs.writeFile(path.join(main,'tracked.txt'),'synthetic staged\n');await git(main,['add','tracked.txt']);
    await fs.writeFile(path.join(main,'tracked.txt'),'synthetic dirty\n');
    await fs.writeFile(path.join(main,'untracked.txt'),'synthetic untracked\n');
    await fs.appendFile(path.join(main,'.git','info','exclude'),'\n/ignored.txt\n');
    await fs.writeFile(path.join(main,'ignored.txt'),'synthetic ignored');
    const before=await git(main,['status','--porcelain']);
    const beforeIndex=await git(main,['diff','--cached']);
    const beforeStashes=await git(main,['stash','list']);
    const held=directories.acquire(store,main);
    const release=await worktrees.acquire(deps,s,main);
    assert.match(s.worktree.branch,/^rundix\/Synthetic-chat-[a-f0-9]{12}$/);
    assert.equal(await git(s.cwd,['branch','--show-current']),s.worktree.branch);
    assert.equal(await fs.readFile(path.join(s.cwd,'tracked.txt'),'utf8'),'synthetic dirty\n');
    assert.equal(await fs.readFile(path.join(s.cwd,'untracked.txt'),'utf8'),'synthetic untracked\n');
    assert.equal(await git(main,['status','--porcelain']),before);
    assert.equal(await git(main,['rev-parse','HEAD']),beforeHead);
    assert.equal(await git(main,['diff','--cached']),beforeIndex);
    assert.equal(await git(main,['stash','list']),beforeStashes);
    await assert.rejects(fs.access(path.join(s.cwd,'ignored.txt')));
    const exclude=await fs.readFile(path.join(main,'.git','info','exclude'),'utf8');
    assert.equal(exclude.split('\n').filter(s=>s==='/.rundix/').length,1);assert.equal(saves,1);
    assert.throws(()=>directories.acquire(store,s.cwd),{code:'SESSION_BUSY'});
    release();held();
    const sub=await worktrees.create(path.join(main,'sub'),'Synthetic sub');
    assert.equal(sub.cwd,path.join(sub.worktree.path,'sub'));
    await fs.writeFile(path.join(sub.worktree.path,'only-nested.txt'),'synthetic nested');
    const nested=await worktrees.create(sub.cwd,'Synthetic nested');
    assert.equal(nested.worktree.mainPath.replace(/\\/g,'/'),main.replace(/\\/g,'/'));
    assert.equal(nested.cwd,path.join(nested.worktree.path,'sub'));
    await assert.rejects(fs.access(path.join(nested.worktree.path,'only-nested.txt')));
    assert.equal((await fs.readFile(path.join(main,'.git','info','exclude'),'utf8')).split('\n').filter(s=>s==='/.rundix/').length,1);
    // A normal linked checkout can also be the origin of a Rundix worktree.
    const linked=path.join(root,'linked');await git(main,['worktree','add','-b','synthetic-linked',linked,'HEAD']);
    const linkedTree=await worktrees.create(path.join(linked,'sub'),'Synthetic linked origin');
    const fromLinkedTree=await worktrees.create(linkedTree.cwd,'Synthetic linked nested');
    assert.equal(await fs.realpath(fromLinkedTree.worktree.mainPath),await fs.realpath(main));
    assert.equal(path.dirname(fromLinkedTree.worktree.path),path.join(main,'.rundix','worktrees'));
    // MCP tasks retain their failure and never move.
    directories.reserve(store,main,'synthetic-task');
    await assert.rejects(worktrees.acquire(deps,{cwd:main},main,{taskId:'other-task'}),{code:'DIRECTORY_RESERVED'});
    const reserved={cwd:main,name:'Synthetic reserved'};const reservedRelease=await worktrees.acquire(deps,reserved,main);reservedRelease();
    directories.release(store,main,'synthetic-task');
    const nonGit=path.join(root,'plain');await fs.mkdir(nonGit);const plainHeld=directories.acquire(store,nonGit);
    await assert.rejects(worktrees.acquire(deps,{cwd:nonGit},nonGit),error=>error.message===worktrees.BUSY);plainHeld();
    // Merge commits with the synthetic repo-local identity and includes untracked files.
    const clean=await repo(root,'merge');const moved=await worktrees.create(clean,'Synthetic merge');
    await fs.writeFile(path.join(moved.cwd,'new.txt'),'synthetic merge');
    await worktrees.merge(moved.worktree,'Synthetic merge');
    assert.equal(await fs.readFile(path.join(clean,'new.txt'),'utf8'),'synthetic merge');
    assert.equal(await worktrees.merged(moved.worktree),true);
    assert.equal((await git(clean,['rev-list','--parents','-n','1','HEAD'])).split(' ').length,3);
    await worktrees.remove(moved.worktree);await assert.rejects(fs.access(moved.cwd));
    // A conflicting merge aborts and preserves both committed sides.
    const conflict=await worktrees.create(clean,'Synthetic conflict');
    await fs.writeFile(path.join(clean,'tracked.txt'),'synthetic main edit\n');await git(clean,['add','-A']);await git(clean,['commit','-m','Synthetic main edit']);
    const head=await git(clean,['rev-parse','HEAD']);
    await fs.writeFile(path.join(conflict.cwd,'tracked.txt'),'synthetic branch edit\n');
    await assert.rejects(worktrees.merge(conflict.worktree,'Synthetic branch edit'),error=>error.reason==='conflict');
    assert.equal(await git(clean,['rev-parse','HEAD']),head);
    assert.equal(await git(clean,['status','--porcelain']),'');
    await assert.rejects(git(clean,['rev-parse','--verify','MERGE_HEAD']));
    assert.equal(await fs.readFile(path.join(conflict.cwd,'tracked.txt'),'utf8'),'synthetic branch edit\n');
    assert.equal(await worktrees.merged(conflict.worktree),false);
    await worktrees.remove(conflict.worktree);await assert.rejects(git(clean,['show-ref','--verify','refs/heads/'+conflict.worktree.branch]));
    // Real directory/session leases surround UI actions; confirmation cancellation is harmless.
    const actionTree=await worktrees.create(clean,'Synthetic actions');
    const chat={key:'synthetic-actions',name:'Synthetic actions',...actionTree};
    let confirmation='',accept=false,infos=0;
    const actions={...deps,info(){infos++;},confirmRemove:async message=>{confirmation=message;return accept;}};
    const mainHeld=directories.acquire(store,clean);
    await assert.rejects(worktrees.operate(actions,chat,'mergeWorktree'),{message:worktrees.WAIT});mainHeld();
    assert.equal(chat.worktreeBusy,false);
    await fs.writeFile(path.join(chat.cwd,'action.txt'),'synthetic unmerged');
    await worktrees.operate(actions,chat,'removeWorktree');
    assert.match(confirmation,/Невлитые/);await fs.access(chat.cwd);
    await worktrees.operate(actions,chat,'mergeWorktree');assert.equal(infos,1);
    accept=true;await worktrees.operate(actions,chat,'removeWorktree');
    assert.equal(chat.worktree,null);assert.equal(chat.cwd,clean);assert.equal(chat.cwdOverride,clean);
    // A failed stash apply removes the worktree AND its new branch, preserving main.
    const cp=require('node:child_process'), originalExec=cp.execFile;
    const modulePath=require.resolve('../runtime/chat-worktrees.cjs');
    let broken,injected=0;
    try {
      cp.execFile=(command,args,options,callback)=>{
        assert.equal(command,'git');assert.ok(options.timeout>0);assert.ok(!options.shell);
        if(args[0]==='-C' && args[2]==='stash' && args[3]==='apply'){injected++;return queueMicrotask(()=>callback(Object.assign(Error('Synthetic apply failure'),{code:1}),'','Synthetic failure'));}
        return originalExec(command,args,options,callback);
      };
      delete require.cache[modulePath];broken=require(modulePath);
    }finally{cp.execFile=originalExec;delete require.cache[modulePath];}
    await fs.writeFile(path.join(clean,'tracked.txt'),'synthetic uncommitted snapshot\n');
    const branches=await git(clean,['branch','--format=%(refname)']);
    const registered=await git(clean,['worktree','list','--porcelain']);
    await assert.rejects(broken.create(clean,'Synthetic failed apply'));
    assert.equal(injected,1);
    assert.equal(await git(clean,['branch','--format=%(refname)']),branches);
    assert.equal(await git(clean,['worktree','list','--porcelain']),registered);
    assert.equal(await fs.readFile(path.join(clean,'tracked.txt'),'utf8'),'synthetic uncommitted snapshot\n');
    await git(clean,['checkout','-q','--','tracked.txt']);
    // Uncommitted changes land in the worktree as one snapshot commit; main stays dirty and untouched.
    {
      await fs.writeFile(path.join(clean,'tracked.txt'),'synthetic snapshot edit\n');await fs.writeFile(path.join(clean,'snap-new.txt'),'synthetic snap new');
      await fs.mkdir(path.join(clean,'nested-repo'));await git(path.join(clean,'nested-repo'),['init','-b','main']);await fs.writeFile(path.join(clean,'nested-repo','n.txt'),'synthetic nested');
      const snap=await worktrees.create(path.join(clean,'sub'),'Synthetic snapshot');
      assert.equal(await git(snap.worktree.path,['log','-1','--format=%s']),'Rundix: snapshot of uncommitted changes');
      assert.equal(await git(snap.worktree.path,['status','--porcelain']),'');
      assert.equal(await fs.readFile(path.join(snap.worktree.path,'snap-new.txt'),'utf8'),'synthetic snap new');
      await assert.rejects(fs.access(path.join(snap.worktree.path,'nested-repo')));
      assert.match(await git(clean,['status','--porcelain']),/tracked.txt/);
      // Merging while main holds the same local changes is refused with the localized reason.
      await assert.rejects(worktrees.merge(snap.worktree,'Synthetic snapshot'),error=>error.reason==='localChanges');
      assert.equal(await git(clean,['status','--porcelain']).then(s=>s.includes('tracked.txt')),true);
      await worktrees.remove(snap.worktree);
      await git(clean,['checkout','-q','--','tracked.txt']);await fs.rm(path.join(clean,'snap-new.txt'));await fs.rm(path.join(clean,'nested-repo'),{recursive:true,force:true});
    }
    // A cwd folder that is untracked is created in the worktree.
    {
      await fs.mkdir(path.join(clean,'only-untracked'));await fs.writeFile(path.join(clean,'only-untracked','u.txt'),'synthetic u');
      const made=await worktrees.create(path.join(clean,'only-untracked'),'Synthetic untracked dir');
      assert.equal(await fs.readFile(path.join(made.cwd,'u.txt'),'utf8'),'synthetic u');
      await worktrees.remove(made.worktree);await fs.rm(path.join(clean,'only-untracked'),{recursive:true,force:true});
    }
    // Categorical errors: non-repository is a busy folder, an unusable repository state a creation failure.
    await assert.rejects(worktrees.create(nonGit,'Synthetic plain'),{notRepo:true});
    // Missing worktree directory: a send recovers, merge explains, remove cleans up after confirmation.
    {
      const lost=await worktrees.create(path.join(clean,'sub'),'Synthetic lost');
      const record={key:'synthetic-lost',name:'Synthetic lost',...lost,cwdOverride:lost.cwd};
      await fs.rm(lost.worktree.path,{recursive:true,force:true});
      assert.equal(await worktrees.gone(lost.worktree),true);
      const acts={...deps,cwd:()=>clean,info(){},confirmRemove:async m=>{confirmation=m;return accept;}};
      await assert.rejects(worktrees.operate(acts,record,'mergeWorktree'),{message:worktrees.GONE});
      assert.equal(record.worktreeBusy,false);
      accept=false;await worktrees.operate(acts,record,'removeWorktree');
      assert.ok(record.worktree);await git(clean,['show-ref','--verify','refs/heads/'+lost.worktree.branch]);
      accept=true;await worktrees.operate(acts,record,'removeWorktree');
      assert.equal(record.worktree,null);assert.equal(record.cwd,path.join(clean,'sub'));
      await assert.rejects(git(clean,['show-ref','--verify','refs/heads/'+lost.worktree.branch]));
      assert.ok(!(await git(clean,['worktree','list','--porcelain'])).includes(lost.worktree.branch.slice(7)));
      const again=await worktrees.create(path.join(clean,'sub'),'Synthetic lost again');
      const stuck={key:'synthetic-stuck',cwd:again.cwd,cwdOverride:again.cwd,worktree:again.worktree};
      await fs.rm(again.worktree.path,{recursive:true,force:true});
      assert.equal(await worktrees.recover(acts,stuck),true);
      assert.equal(stuck.worktree,null);assert.equal(stuck.cwd,path.join(clean,'sub'));assert.equal(stuck.cwdOverride,stuck.cwd);
      assert.equal(await worktrees.recover(acts,stuck),false);
      // A fork inherits only the cwd; it falls back to the workspace folder.
      const fork={key:'synthetic-fork',cwd:path.join(clean,'.rundix','worktrees','gone-0123456789ab','sub')};
      assert.equal(await worktrees.recover(acts,fork),true);assert.equal(fork.cwd,clean);
      await git(clean,['worktree','prune']);await git(clean,['branch','-D',again.worktree.branch]);
    }
    // History keeps moved chats under their workspace.
    {
      const listStore=new SessionStore(path.join(root,'history'));
      listStore.write('session','plain',{key:'plain',cwd:clean,updatedAt:1});
      listStore.write('session','moved',{key:'moved',cwd:path.join(clean,'.rundix','worktrees','x','sub'),worktree:{mainPath:clean,mainCwd:path.join(clean,'sub')},updatedAt:2});
      listStore.write('session','forked',{key:'forked',cwd:path.join(clean,'.rundix','worktrees','y'),updatedAt:3});
      listStore.write('session','other',{key:'other',cwd:path.join(root,'elsewhere'),updatedAt:4});
      assert.deepEqual(listStore.list(clean).map(row=>row.key),['forked','moved','plain']);
      assert.deepEqual(listStore.list(path.join(clean,'sub')).map(row=>row.key),['moved']);
      assert.equal(listStore.list().length,4);
    }
    // Missing git follows the same localized busy-folder path, with no state move.
    let missing;
    try {
      cp.execFile=(_command,_args,_options,callback)=>queueMicrotask(()=>callback(Object.assign(Error('Synthetic missing git'),{code:'ENOENT'}),'',''));
      delete require.cache[modulePath];missing=require(modulePath);
    }finally{cp.execFile=originalExec;delete require.cache[modulePath];}
    const missingChat={cwd:clean,name:'Synthetic missing git'};const busyMain=directories.acquire(store,clean);
    try{await assert.rejects(missing.acquire(deps,missingChat,clean),{message:worktrees.BUSY});assert.equal(missingChat.cwd,clean);assert.equal(missingChat.worktree,undefined);}
    finally{busyMain();}
    // A worktree creation failure is categorical, keeps the chat in place and leaks no git output.
    let failing;
    try {
      cp.execFile=(command,args,options,callback)=>args[2]==='worktree' && args[3]==='add'?queueMicrotask(()=>callback(Object.assign(Error('Synthetic add failure'),{code:128}),'','fatal: synthetic secret path')):originalExec(command,args,options,callback);
      delete require.cache[modulePath];failing=require(modulePath);
    }finally{cp.execFile=originalExec;delete require.cache[modulePath];}
    const failChat={cwd:clean,name:'Synthetic failing add'};const failHeld=directories.acquire(store,clean);
    try{
      await assert.rejects(failing.acquire(deps,failChat,clean),error=>/^Не удалось создать worktree: ошибка Git\. Черновик сохранён\.$/.test(error.message));
      assert.equal(failChat.cwd,clean);assert.equal(failChat.worktree,undefined);
      assert.equal(await failing.acquire(deps,failChat,clean,{defer:true}),null);
    }finally{failHeld();}
    console.log('Synthetic chat worktrees: OK');
  }finally{
    // The exact mkdtemp target is verified before recursive cleanup.
    assert.equal(await fs.realpath(path.dirname(root)),await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('rundix-synthetic-worktrees-'));
    await fs.rm(root,{recursive:true,force:true});
  }
}
module.exports={repo,git};
if(require.main===module)run().catch(error=>{console.error('Synthetic chat worktree test failed:',error.code || '',error.reason || '',error.message.replace(/[A-Z]:[^\n]*/gi,'[synthetic path]'));console.error(error.stack?.match(/chat-worktrees.cjs:\d+/g));process.exitCode=1;});
