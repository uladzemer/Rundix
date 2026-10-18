const assert = require('node:assert/strict');
const path = require('node:path');
const { newSessionSettings } = require('../runtime/new-session-settings.cjs');

const cwd = path.resolve('synthetic-project');
const source = { cwd, model: 'fixture', effort: 'high', draft: 'private draft', items: ['history'],
  prefs: { mode: 'full', access: 'full', fast: true, focus: true, showThinking: false, ide: true,
    pendingMode: null, beforeUltra: { fixture: 'medium' } } };
const inherited = newSessionSettings(source, cwd);
assert.deepEqual(inherited, { model: 'fixture', effort: 'high',
  prefs: { mode: 'full', access: 'full', plan: false, focus: true, showThinking: false, ide: true, fast: true } });
inherited.prefs.fast = false;
assert.equal(source.prefs.fast, true);
assert.deepEqual(newSessionSettings(source, path.resolve('other-project')), {});
assert.deepEqual(newSessionSettings(source, undefined), {});
assert.deepEqual(newSessionSettings(undefined, cwd), {});
if (process.platform === 'win32') assert.equal(newSessionSettings(source, cwd.toUpperCase()).prefs.mode, 'full');
source.prefs.pendingMode = 'manual';
assert.deepEqual(newSessionSettings(source, cwd).prefs, { ...inherited.prefs, mode: 'manual', access: 'read', fast: true });
source.prefs.pendingMode = 'unknown';
assert.equal(newSessionSettings(source, cwd).prefs.mode, 'full');
source.prefs = { access: 'full' };
assert.equal(newSessionSettings(source, cwd).prefs.mode, 'full');
console.log('New session settings checks passed');
