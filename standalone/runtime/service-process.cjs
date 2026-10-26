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
// Get-Process cannot read StartTime of protected/system/other-user processes; Win32_Process
// CreationDate (CIM) is readable for all of them. pid is a checked integer, never shell text.
function windowsStartScript(pid) {
  return `$ErrorActionPreference='Stop';$t=$null;try{$t=(Get-Process -Id ${pid}).StartTime}catch{};` +
    `if(-not $t){$t=(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate};$t.ToUniversalTime().Ticks`;
}
function query(pid, platform) {
  return platform === 'win32'
    ? ['powershell.exe', ['-NoProfile','-NonInteractive','-Command', windowsStartScript(pid)], options]
    : ['/bin/ps', ['-p',String(pid),'-o','lstart='], {...options, env:{...process.env, LC_ALL:'C', TZ:'UTC'}}];
}
// No auth files, shell expansion, or process command lines are read here.
function processIdentity(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return {state:'unknown'};
  const state = present(pid);
  if (state === 'dead') return {state}; // EPERM (unknown) still gets a start-time query: protected PIDs are the reuse case
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
  if (state === 'dead') return {state}; // EPERM (unknown) still gets a start-time query: protected PIDs are the reuse case
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
// Windows start times are .NET ticks; the CIM fallback differs from Get-Process by sub-millisecond rounding.
const ticksPattern = /^[0-9]{15,19}$/;
function sameStart(a, b) {
  if (a === b) return true;
  if (!ticksPattern.test(a) || !ticksPattern.test(b)) return false;
  const gap = BigInt(a) - BigInt(b);
  return (gap < 0n ? -gap : gap) <= 100000n;
}
// Process creation time in epoch ms when the identity carries Windows ticks; otherwise null.
function startedAtMs(identity) {
  if (identity?.state !== 'alive' || !ticksPattern.test(identity.processStart || '')) return null;
  return Number((BigInt(identity.processStart) - 621355968000000000n) / 10000n);
}
function ownerState(descriptor, inspect = processIdentity) {
  if (!descriptor) return 'unknown';
  const current = inspect(descriptor.pid);
  if (current.state === 'dead') return 'dead';
  if (current.state !== 'alive' || !current.processStart || !descriptor.processStart) return 'unverified';
  if (!sameStart(current.processStart, descriptor.processStart)) return 'dead';
  return 'alive';
}
module.exports = {processIdentity, processIdentityAsync, ownerState, startedAtMs, windowsStartScript};
