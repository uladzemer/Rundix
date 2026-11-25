const fs = require('node:fs/promises');
const path = require('node:path');

const uuid = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}';
const temp = new RegExp(`^(?:(?:bridge|installation|settings|legacy-roots|lease-(?:service-startup|service-install|legacy-roots))\\.json\\.|lease-(?:service-startup|service-install|legacy-roots)\\.json\\.reap\\.\\d+-)${uuid}\\.tmp$`);
const backup = new RegExp(`^legacy-roots\\.json\\.cleanup-${uuid}\\.bak$`);
const ignored = error => ['ENOENT', 'EBUSY', 'EPERM'].includes(error.code);

async function cleanupServiceRoot(root, {now = Date.now, files = fs, maxEntries = 1024, signal} = {}) {
  const cutoff = now() - 30 * 24 * 60 * 60 * 1000;
  const backups = [];
  let removed = 0, complete = true;
  async function remove(file, mtime) {
    try {
      const stat = await files.lstat(file);
      if (!signal?.aborted && stat.isFile() && stat.mtimeMs === mtime && stat.mtimeMs < cutoff) { await files.unlink(file); removed++; }
    } catch (error) { if (!ignored(error)) throw error; }
  }
  const directory = await files.opendir(root);
  try {
    for (let i = 0; ; i++) {
      if (signal?.aborted) return removed;
      if (i === maxEntries) { complete = false; break; }
      const entry = await directory.read();
      if (!entry) break;
      const file = path.join(root, entry.name);
      const temporary = temp.test(entry.name);
      if (!temporary && !backup.test(entry.name)) continue;
      try {
        const stat = await files.lstat(file);
        if (!stat.isFile()) continue;
        if (temporary) { if (stat.mtimeMs < cutoff) await remove(file,stat.mtimeMs); }
        else backups.push({file, mtime:stat.mtimeMs});
      } catch (error) {
        if (!ignored(error)) throw error;
        if (error.code !== 'ENOENT') complete = false;
      }
    }
  } finally { await directory.close(); }
  // Only prune backups when we could identify the newest one across the root.
  if (complete) {
    backups.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
    for (const {file,mtime} of backups.slice(1)) { if (signal?.aborted) break; await remove(file,mtime); }
  }
  return removed;
}

module.exports = {cleanupServiceRoot};
