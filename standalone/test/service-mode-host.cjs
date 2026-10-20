const vscode = require('vscode'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
exports.run = async () => {
  const report = {syntheticTransport:true, inferencePerformed:false}, launcher = require('../runtime/service-launcher.cjs');
  const original = launcher.installLauncherAsync; let installs = 0;
  try {
    await vscode.workspace.getConfiguration('rundix').update('mcpService', 'service', vscode.ConfigurationTarget.Global);
    await assert.rejects(vscode.workspace.getConfiguration('rundix').update('mcpService', 'window', vscode.ConfigurationTarget.Workspace));
    launcher.installLauncherAsync = () => {installs++;return {root:path.join(__dirname,'../.verification/service-settings-synthetic'),launcher:'synthetic-launcher', configuration:{mcpServers:{rundix:{command:'node', args:['synthetic-launcher','--service']}}}};};
    const api = await vscode.extensions.getExtension('local-rundix-tools.rundix').activate();
    assert.equal(api.mcp.panelSnapshot().serviceMode, true, 'Only globalValue chooses mode');
    await assert.rejects(api.mcp.connectPool(), {code:'unsupported'});
    assert.equal(await api.mcp.start(), 'synthetic-launcher');
    assert.equal(installs, 1); assert.equal(api.mcp.tasks(), null, 'No window MCP host started');
    const result = await api.mcp.panelAction({action:'configuration'});
    assert.deepEqual(result.configuration.mcpServers.rundix.args, ['synthetic-launcher','--service']);
    assert.deepEqual(api.mcp.panelSnapshot().tasks, []);
    await api.mcp.start(); assert.equal(installs, 1);
    const settingsFile=path.join(__dirname,'../.verification/service-settings-synthetic/settings.json');
    await vscode.workspace.getConfiguration('rundix').update('mcpAccessMode','manual',vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('rundix').update('mcpThreadConfig',{model:'synthetic-model'},vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('rundix').update('cliPath',process.execPath,vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('rundix').update('mcpMaxParallelTasks',2,vscode.ConfigurationTarget.Global);
    const deadline=Date.now()+5000;while(Date.now()<deadline){if(JSON.parse(fs.readFileSync(settingsFile,'utf8')).mcpMaxParallelTasks===2)break;await new Promise(resolve=>setTimeout(resolve,20));}
    const settings=JSON.parse(fs.readFileSync(settingsFile,'utf8'));assert.equal(settings.mcpAccessMode,'manual');assert.equal(settings.mcpMaxParallelTasks,2);assert.deepEqual(settings.mcpThreadConfig,{model:'synthetic-model'});assert.equal(settings.cliPath,process.execPath);
    await api.mcp.stop(); assert.equal(api.mcp.panelSnapshot().bridgeRunning, false);
    report.globalOnly = true; report.noWindowExecutor = true; report.serviceConfiguration = true; report.passed = true;
  } catch (error) {report.error = error.message;report.passed = false;}
  finally {launcher.installLauncherAsync = original;fs.writeFileSync(path.join(__dirname,'../.verification/service-mode-host.json'), JSON.stringify(report,null,2));}
};
