// Audit the final ZIP, rather than trusting only the source-tree ignore rules.
const fs = require('node:fs');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const path = require('node:path');

function audit(file) {
  const zip = fs.readFileSync(file);
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  assert(end >= 0 && zip.readUInt32LE(end) === 0x06054b50, 'Missing ZIP directory');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const names = new Set(), sources = new Map();
  const allowed = /^(?:extension\.vsixmanifest|\[Content_Types\]\.xml|extension\/(?:extension\.cjs|LICENSE(?:\.txt)?|package(?:\.nls(?:\.ru)?)?\.json|(?:readme|changelog)\.md|THIRD_PARTY_NOTICES\.txt|runtime\/(?!.*-source\.cjs$)[\w-]+\.cjs|runtime\/cli-manifest\.json|ui\/[\w-]+\.(?:js|css)|resources\/(?:rundix-(?:dark|light)\.svg|extension-icon\.png)|resources\/icons\/(?:[\w-]+\.svg|NOTICE\.md|sources\.json)))$/i;
  const checks = [
    ['JWT', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/],
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['API token', /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,}|AKIA[A-Z0-9]{16})\b/],
    ['personal home path', /(?:[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|<)[\w.-]+|\/(?:Users|home)\/(?!<)[\w.-]+)/i],
    ['private deployment address', /\b[\w.-]+\.workers\.dev\b/i],
    ['embedded credential', /["']?(?:access_token|refresh_token|id_token|ADMIN_KEY|VAULT_KEY)["']?\s*[:=]\s*["'][A-Za-z0-9_./+=-]{24,}["']/i],
  ];
  for (let index = 0; index < count; index++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50, 'Invalid ZIP entry');
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert(!/^extension\/runtime\/(?:cloud-auth|account-(?:profiles|refresh|usage|rotation))\.cjs$/.test(name), 'Unexpected non-local authentication module');
    assert(allowed.test(name) || name === 'extension/docs/mcp.md', `Unexpected packaged file: ${name}`);
    assert(!names.has(name), `Duplicate packaged file: ${name}`);
    names.add(name);
    assert.equal(zip.readUInt32LE(local), 0x04034b50, 'Invalid local ZIP entry');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const compressed = zip.subarray(start, start + size);
    assert(method === 0 || method === 8, 'Unsupported ZIP compression');
    const data = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    const text = data.toString('utf8');
    if (/^extension\/.*\.c?js$/.test(name)) sources.set(name, text);
    for (const [label, pattern] of checks) {
      // Never include the matched value in logs.
      assert(!pattern.test(text), `${label} detected in ${name}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  // Check the source extracted from the actual ZIP, not the test-patched module cache.
  const contract = require('./production-service-contract.cjs');
  contract.validatePaths(sources.get('extension/runtime/service-paths.cjs'));
  contract.validateEnvironment(sources.get('extension/runtime/service-environment.cjs'));
  // Experimental service mode ships its complete runtime, never synthetic fixtures.
  for (const module of ['service-paths','service-endpoint','service-ipc','service-process','service-lifecycle','service-space','service-cli',
    'service-json','service-provider-config','service-provider-rpc','service-provider-contract','service-provider',
    'service-headless-host','service-readiness','task-recovery','service-task-status','service-main','service-task-rpc','service-limit-poller','service-adapter','service-launcher','service-environment','service-settings','service-task-archive','service-fatal',
    'service-connection','service-window-rpc','service-window-client','service-projection','service-task-chat','service-migration']) {
    assert(names.has(`extension/runtime/${module}.cjs`), 'Missing headless module');
  }
  for (const required of ['extension/extension.cjs', 'extension/package.json', 'extension/readme.md', 'extension/changelog.md',
    'extension/runtime/mcp-server.cjs', 'extension/runtime/mcp-bridge.cjs', 'extension/runtime/mcp-tasks.cjs',
    'extension/runtime/account-lifecycle.cjs',
    'extension/runtime/session-persistence.cjs',
    'extension/runtime/session-core.cjs', 'extension/runtime/mcp-host.cjs', 'extension/runtime/session-actions.cjs',
    'extension/runtime/session-resume.cjs',
    'extension/runtime/server-connection.cjs',
    'extension/runtime/send-queue.cjs',
    'extension/runtime/question-policy.cjs',
    'extension/runtime/question-answer.cjs',
    'extension/runtime/mcp-access.cjs',
    'extension/runtime/mcp-executor.cjs', 'extension/runtime/composer-draft.cjs', 'extension/runtime/mcp-input-recovery.cjs',
    'extension/runtime/task-directory.cjs', 'extension/docs/mcp.md',
    'extension/runtime/connection-companions.cjs', 'extension/runtime/mcp-panel.cjs',
    'extension/ui/mcp-panel.js', 'extension/ui/mcp-panel.css', 'extension/ui/composer-drafts.js',
    'extension/ui/service-chat.js', 'extension/ui/service-chat.css',
    'extension/runtime/new-session-settings.cjs',
    'extension/runtime/queued-edits.cjs', 'extension/ui/queued-editor.js',
    'extension/runtime/queued-attachments.cjs',
    'extension/runtime/queued-session-transfer.cjs',
    'extension/LICENSE.txt', 'extension/THIRD_PARTY_NOTICES.txt', 'extension/resources/extension-icon.png',
    'extension/resources/rundix-dark.svg', 'extension/resources/rundix-light.svg',
    'extension/resources/icons/rundix.svg']) {
    assert(names.has(required), `Missing packaged file: ${required}`);
  }
  // Every relative module a packaged script requires must itself be packaged; a new runtime file
  // missing from .vscodeignore would otherwise only fail when the installed extension activates.
  for (const [name, text] of sources) {
    for (const match of text.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]));
      assert(names.has(target), `Missing packaged module ${target} required by ${name}`);
    }
  }
  console.log(`Package audit passed: ${count} files; only distributable assets; no detected credential or personal-path patterns.`);
}

if (require.main === module) audit(process.argv[2]);
module.exports = {audit};
