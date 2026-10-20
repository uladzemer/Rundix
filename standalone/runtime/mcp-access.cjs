// Host state is supplied explicitly; mutable values are read through deps.
function mcpThreadConfig(deps, s) {
  if(!s.mcpTask)return null;
  const value=deps.vscode.workspace.getConfiguration('rundix').inspect('mcpThreadConfig')?.globalValue;
  return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length?value:null;
}
module.exports = { mcpThreadConfig };
