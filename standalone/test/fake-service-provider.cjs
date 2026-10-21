// Synthetic v2 companion fixture. Copied to an isolated versioned install by
// tests, alongside the shared framed transport. No pool, broker or auth files.
const {ProviderPeer, rpcError} = require('./service-provider-rpc.cjs');
const {CAPABILITIES} = require('./service-provider-contract.cjs');
let scenario = 'ready', accountGrant = null, idleGrant = null;
let releasePrepare;
let statusChecks = 0;
const counts = {authenticate:0, prepareTurn:0, handleRequest:0, turnStarted:0, turnTerminal:0};
const peer = new ProviderPeer({readable:process.stdin, writable:process.stdout, call:async (method, params, context) => {
  if (method === 'hello') return {version:{major:2, minor:0}, providerId:'synthetic-provider', providerVersion:'1.0.0', capabilities:CAPABILITIES};
  if (method === 'configureByClient') {
    scenario = params.payload?.scenario || 'ready';
    if (scenario === 'pending-config') return {kind:'pending', operationId:params.operationId};
    return {kind:'configured', selectionRevision:params.expectedSelectionRevision + 1};
  }
  if (method === 'authenticate') {
    counts.authenticate++;
    if (scenario === 'auth-required') return {kind:'unavailable', code:'AUTH_REQUIRED', retryable:false, retryAfterMs:0, messageKey:'synthetic.auth'};
    let fence = context.fence, effectiveBinding, login;
    if (scenario === 'reconnect') {
      const {result} = await peer.request('cli/reconnect', {parentRequestId:context.id, owner:{leaseId:fence.binding.leaseId}, binding:fence.binding, idleGrantId:idleGrant?.leaseId}, fence, 5000);
      effectiveBinding = result.effectiveBinding; fence = {...fence, binding:effectiveBinding};
    }
    if (scenario !== 'no-login') {
      login = await peer.request('cli/request', {parentRequestId:scenario === 'stale-parent' ? 'retired-parent' : context.id,
        owner:{leaseId:scenario === 'stale-owner' ? 'foreign-owner' : fence.binding.leaseId}, binding:fence.binding, idleGrantId:idleGrant?.leaseId,
        method:scenario === 'logout' ? 'account/logout' : 'account/login/start',
        params:{type:'chatgptAuthTokens', accessToken:'SYNTHETIC_NOT_A_CREDENTIAL', chatgptAccountId:'synthetic-account', chatgptPlanType:'plus'}}, fence, 5000);
    }
    return {kind:'authenticated', accountRevision:scenario.startsWith('scan-') ? login.result.nextAccountRevision : fence.binding.accountRevision || 1, ...(effectiveBinding ? {effectiveBinding} : {})};
  }
  if (method === 'prepareTurn') {
    counts.prepareTurn++;
    if(scenario==='prepare-reconnect'){
      const {result:reconnected}=await peer.request('cli/reconnect',{parentRequestId:context.id,owner:{leaseId:context.fence.binding.leaseId},
        binding:context.fence.binding,idleGrantId:idleGrant?.leaseId},context.fence,5000);
      const fence={...context.fence,binding:reconnected.effectiveBinding};
      const {result:login}=await peer.request('cli/request',{parentRequestId:context.id,owner:{leaseId:fence.binding.leaseId},
        binding:fence.binding,idleGrantId:idleGrant?.leaseId,method:'account/login/start',
        params:{type:'chatgptAuthTokens',accessToken:'SYNTHETIC_NOT_A_CREDENTIAL',chatgptAccountId:'synthetic-reconnected'}},fence,5000);
      scenario='ready';
      return {kind:'ready',effectiveBinding:fence.binding,accountRevision:login.nextAccountRevision,authGrantId:login.authGrantId,
        limitsSnapshotId:'synthetic-limits',checkRevision:1,validUntil:Date.now()+60000};
    }
    if (scenario.startsWith('scan-')) {
      await peer.request('cli/request', {parentRequestId:context.id, owner:{leaseId:context.fence.binding.leaseId}, binding:context.fence.binding, idleGrantId:idleGrant?.leaseId,
        method:'account/login/start', params:{type:'chatgptAuthTokens', accessToken:'SYNTHETIC_NOT_A_CREDENTIAL', chatgptAccountId:scenario === 'scan-same' ? 'synthetic-account' : 'synthetic-scanned-account'}}, context.fence, 5000);
      if (['scan-wait','scan-same','scan-invalid'].includes(scenario)) return {kind:'waitUntil', waitId:scenario === 'scan-invalid' ? 'foreign-wait' : params.waitId, resetAt:Date.now() + 30000, reason:'exhausted'};
      return {kind:'unavailable', code:scenario.slice(5), retryable:true, retryAfterMs:1000, messageKey:'synthetic.scan'};
    }
    if (scenario === 'refresh-barrier' && params.taskId === 'refresh-prepare') await new Promise(resolve => {releasePrepare = resolve;});
    if (scenario === 'slow') await new Promise(resolve => setTimeout(resolve, 80));
    if (scenario === 'wait') return {kind:'waitUntil', waitId:params.waitId, resetAt:Date.now() + 30000, reason:'low_remaining'};
    if (scenario === 'unknown-limits') return {kind:'unavailable', code:'LIMITS_UNKNOWN', retryable:true, retryAfterMs:500, messageKey:'synthetic.limits'};
    if (scenario === 'needs-decision') return {kind:'needsDecision', decisionId:'synthetic-decision', reason:'low_remaining', options:['wait', 'cancel'], resetAt:null};
    if (scenario === 'auth-required') return {kind:'unavailable', code:'AUTH_REQUIRED', retryable:false, retryAfterMs:0, messageKey:'synthetic.auth'};
    if (scenario === 'change-account-old-revision' || scenario === 'change-account-new-revision') {
      const oldGrant = accountGrant.leaseId;
      const {result} = await peer.request('cli/request', {parentRequestId:context.id, owner:{leaseId:context.fence.binding.leaseId}, binding:context.fence.binding, idleGrantId:idleGrant?.leaseId,
        method:'account/login/start', params:{type:'chatgptAuthTokens', accessToken:'SYNTHETIC_NOT_A_CREDENTIAL', chatgptAccountId:'synthetic-other-account'}}, context.fence, 5000);
      return {kind:'ready', accountRevision:scenario === 'change-account-old-revision' ? context.fence.binding.accountRevision : result.nextAccountRevision,
        authGrantId:scenario === 'change-account-old-revision' ? oldGrant : result.authGrantId,
        limitsSnapshotId:'synthetic-limits', checkRevision:1, validUntil:Date.now() + 60000};
    }
    return {kind:'ready', accountRevision:context.fence.binding.accountRevision,
      authGrantId:scenario === 'bad-grant' ? 'unknown-grant' : accountGrant?.leaseId,
      limitsSnapshotId:'synthetic-limits', checkRevision:1, validUntil:Date.now() + 60000};
  }
  if (method === 'handleRequest') {
    counts.handleRequest++;
    releasePrepare?.(); releasePrepare = null;
    if (scenario.startsWith('refresh-refuse-')) return {kind:'cliResponse', requestId:params.request.id,
      response:{code:scenario.slice(15), messageKey:'SYNTHETIC_PRIVATE_DIAGNOSTIC'}};
    if (scenario === 'refresh-unavailable') return {kind:'unavailable', code:'PROVIDER_PROCESS_UNCERTAIN', retryable:false, retryAfterMs:0, messageKey:'SYNTHETIC_PRIVATE_DIAGNOSTIC'};
    if (scenario === 'refresh-rpc-refusal') throw rpcError('STALE_FENCE');
    if (scenario === 'refresh-wrong-id') return {kind:'cliResponse', requestId:'foreign-request', response:{code:'AUTH_REQUIRED',messageKey:'synthetic.auth'}};
    if (scenario === 'refresh-mixed-refusal') return {kind:'cliResponse', requestId:params.request.id, response:{code:'AUTH_REQUIRED',accessToken:'SYNTHETIC_MUST_NOT_ESCAPE',messageKey:'synthetic.auth'}};
    return {kind:'cliResponse', requestId:params.request.id,
      response:{accessToken:'SYNTHETIC_REFRESH_NOT_A_CREDENTIAL', chatgptAccountId:scenario === 'refresh-other-account' ? 'synthetic-other-account' : 'synthetic-account', chatgptPlanType:'plus'}};
  }
  if (method === 'cancelWait') return {kind:'cancelled', waitId:params.waitId};
  if (method === 'status') {
    if (scenario === 'pending-config') return {kind:++statusChecks < 2 ? 'pending' : 'succeeded', operationId:params.operationId};
    if (scenario === 'bad-status') return {status:'ready', accessToken:'SYNTHETIC_NOT_A_CREDENTIAL'};
    return {authenticated:!!accountGrant, activeTurns:0, preparing:false, counts};
  }
  if (method === 'dispose') return {kind:'disposed'};
  throw rpcError('METHOD_NOT_SUPPORTED');
}});
peer.on('event', (method, params) => {
  if (method === 'lease/grant' && params.grant.kind === 'idle') idleGrant = params.grant;
  if (method === 'lease/grant' && params.grant.kind === 'account') accountGrant = params.grant;
  if (method === 'turnStarted') counts.turnStarted++;
  if (method === 'turnTerminal') counts.turnTerminal++;
});
peer.on('closed', () => { process.exitCode = 0; });
