const path = require('node:path');
const modes = require('../ui/modes.js');

// Only composer choices cross into a new session, never conversation state.
function newSessionSettings(source, cwd) {
  const projectPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (!source?.cwd || !cwd || projectPath(source.cwd) !== projectPath(cwd)) return {};
  const selected = modes.modes.find(mode => mode.id === source.prefs?.pendingMode) || modes.current(source.prefs);
  const prefs = { mode: selected.id, access: selected.access, plan: !!selected.plan };
  for (const key of ['focus', 'showThinking', 'ide', 'fast']) {
    if (typeof source.prefs?.[key] === 'boolean') prefs[key] = source.prefs[key];
  }
  return { model: source.model, effort: source.effort, prefs };
}

module.exports = { newSessionSettings };
