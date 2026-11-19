const preferredModel = 'gpt-6.2-sol';
const efforts = ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function normalizeModel(value) {
  if (typeof value === 'string' && value.trim().length <= 200 && !/[\x00-\x1f\x7f]/.test(value)) return value.trim();
}

function normalizeEffort(value) {
  if (efforts.includes(value)) return value;
}

function readDefaults(settings) {
  return {model:normalizeModel(settings('mcpDefaultModel')), effort:normalizeEffort(settings('mcpDefaultEffort'))};
}

function resolveSelection(selection, requested, defaults, catalog) {
  const preferred = defaults.model === undefined && catalog.find(entry => entry.model === preferredModel);
  const model = requested?.model || defaults.model || preferred?.model || selection.model;
  const entry = catalog.find(candidate => candidate.model === model);
  const preferMedium = !requested?.model && preferred && preferred.supportedReasoningEfforts?.some(option => option.reasoningEffort === 'medium');
  const configuredEffort = !requested?.model && defaults.effort !== 'auto' ? defaults.effort : undefined;
  const modelEffort = preferMedium ? 'medium' : entry?.defaultReasoningEffort;
  const effort = requested?.effort ?? configuredEffort ??
    (requested?.model || defaults.model || preferred ? modelEffort : selection.effort);
  return {...selection, model, effort};
}

module.exports = {preferredModel, normalizeModel, normalizeEffort, readDefaults, resolveSelection};
