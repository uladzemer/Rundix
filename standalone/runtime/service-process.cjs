'use strict';
const fs = require('node:fs');
const {execFileSync, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const runAsync = promisify(execFile);
const options = {encoding:'utf8', windowsHide:true, timeout:10000, maxBuffer:16384};
let selfIdentity;
function present(pid) {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}
function query(pid, platform) {
  return platform === 'win32'
    ? ['powershell.exe', ['-NoProfile','-NonInteractive','-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], options]
    : ['/bin/ps', ['-p',String(pid),'-o','lstart='], {...options, env:{...process.env, LC_ALL:'C', TZ:'UTC'}}];
}
// No auth files, shell expansion, or process command lines are read here.
function processIdentity(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return {state:'unknown'};
  const state = present(pid);
  if (state !== 'alive') return {state};
  if (pid === process.pid && platform === process.platform && selfIdentity) return selfIdentity;
  try {
    let processStart;
    if (platform === 'win32') {
      processStart = execFileSync(...query(pid,platform)).trim();
    } else if (platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      processStart = fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim() + ':' + ticks;
    } else {
      processStart = execFileSync(...query(pid,platform)).trim();
    }
    const result = processStart ? {state:'alive', processStart} : {state:'unknown'};
    if (pid === process.pid && platform === process.platform && processStart) selfIdentity = result;
    return result;
  } catch { return {state:'unknown'}; }
}
// Remote owners are deliberately not cached: PID reuse must be checked afresh.
// Endpoint recovery uses this async query so PowerShell/ps cannot block IPC timers.
async function processIdentityAsync(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return {state:'unknown'};
  const state = present(pid);
  if (state !== 'alive') return {state};
  if (pid === process.pid && platform === process.platform && selfIdentity) return selfIdentity;
  if (platform === 'linux') return processIdentity(pid,platform);
  try {
    const {stdout} = await runAsync(...query(pid,platform));
    const processStart = stdout.trim();
    const result = processStart ? {state:'alive',processStart} : {state:'unknown'};
    if (pid === process.pid && platform === process.platform && processStart) selfIdentity = result;
    return result;
  } catch { return {state:'unknown'}; }
}
function ownerState(descriptor, inspect = processIdentity) {
  if (!descriptor) return 'unknown';
  const current = inspect(descriptor.pid);
  if (current.state === 'dead') return 'dead';
  if (current.state !== 'alive' || !current.processStart || !descriptor.processStart) return 'unverified';
  if (current.processStart !== descriptor.processStart) return 'dead';
  return 'alive';
}
module.exports = {processIdentity, processIdentityAsync, ownerState};
