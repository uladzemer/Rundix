const DEADLINES = Object.freeze({hello:5000, authenticate:70000, prepareTurn:90000,
  handleRequest:9000, cancelWait:3000, configureByClient:15000, status:3000, dispose:2000,
  'cli/request':70000, 'cli/reconnect':90000});
const CAPABILITIES = Object.freeze([...Object.keys(DEADLINES), 'lease/grant', 'lease/revoke',
  'turnStarted', 'turnTerminal', 'connectionChanged']);
const REASONS = Object.freeze(['low_remaining', 'exhausted', 'limits_unknown', 'reset_unknown',
  'active_turns', 'action_required', 'connection_changed']);
const UNAVAILABLE_CODES = Object.freeze(['LIMITS_UNKNOWN', 'RESET_UNKNOWN', 'BUSY_ACTIVE', 'AUTH_REQUIRED',
  'AUTH_REVOKED', 'STORE_UNAVAILABLE', 'CLIENT_REQUIRED', 'PLATFORM_UNSUPPORTED', 'PROVIDER_PROCESS_UNCERTAIN', 'MIRROR_BUSY']);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function equal(a, b) { return canonical(a) === canonical(b); }
const FIELDS = Object.freeze({authenticated:['accountRevision', 'effectiveBinding'],
  cliResponse:['requestId', 'response'], ready:['accountRevision', 'authGrantId', 'limitsSnapshotId', 'validUntil', 'checkRevision', 'effectiveBinding'],
  waitUntil:['waitId', 'resetAt', 'reason'], needsDecision:['decisionId', 'reason', 'options', 'resetAt'],
  unavailable:['code', 'retryable', 'retryAfterMs', 'messageKey'], cancelled:['waitId'],
  configured:['selectionRevision'], pending:['operationId'], succeeded:['operationId'], failed:['operationId', 'code'],
  uncertain:['operationId', 'code'], disposed:[]});
function knownOutcome(result) {
  return !!FIELDS[result?.kind] && Object.keys(result).every(key => key === 'kind' || FIELDS[result.kind].includes(key));
}
module.exports = {DEADLINES, CAPABILITIES, REASONS, UNAVAILABLE_CODES, equal, knownOutcome};
