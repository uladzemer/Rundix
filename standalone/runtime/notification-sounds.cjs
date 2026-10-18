const fs = require('node:fs/promises');
const path = require('node:path');

function supported(platform) { return platform === 'win32' || platform === 'darwin'; }
function extensions(platform) { return platform === 'darwin' ? ['aiff', 'aif', 'wav', 'caf', 'mp3', 'm4a'] : ['wav']; }
function defaultSound(platform) { return supported(platform) ? 'system' : ''; }

async function soundFiles(platform, { readDirectory = fs.readdir, windowsRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  const directory = platform === 'win32' ? path.join(windowsRoot, 'Media') : '/System/Library/Sounds';
  if (!supported(platform)) return [];
  try {
    const allowed = extensions(platform);
    return (await readDirectory(directory)).filter(name => allowed.includes(path.extname(name).slice(1).toLowerCase()))
      .sort().map(name => ({ label: path.parse(name).name, sound: path.join(directory, name) }));
  } catch (error) {
    // Default signal/custom file still work if the optional sound library is absent.
    if (error.code === 'ENOENT' || error.code === 'EACCES') return [];
    throw error;
  }
}

async function playSound(sound, { platform, execute, stat = fs.stat }) {
  if (!supported(platform)) throw Error('unsupported-sound-platform');
  if (!sound) return;
  if (sound !== 'system') {
    if (!path.isAbsolute(sound) || !extensions(platform).includes(path.extname(sound).slice(1).toLowerCase())) throw Error('invalid-sound');
    const file = await stat(sound);
    if (!file.isFile() || file.size > 20 * 1024 * 1024) throw Error('invalid-sound');
  }
  if (platform === 'darwin') {
    if (sound === 'system') await execute('/usr/bin/osascript', ['-e', 'beep'], '', {}, 15000);
    else await execute('/usr/bin/afplay', [sound], '', {}, 15000);
    return;
  }
  const script = sound === 'system' ? '[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 700' :
    '$ErrorActionPreference = "Stop"; $player = New-Object System.Media.SoundPlayer; try { $player.SoundLocation = $env:CODEX_NOTIFICATION_SOUND; $player.Load(); $player.PlaySync() } finally { $player.Dispose() }';
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], '', { CODEX_NOTIFICATION_SOUND: sound }, 15000);
}

module.exports = { supported, extensions, defaultSound, soundFiles, playSound };
