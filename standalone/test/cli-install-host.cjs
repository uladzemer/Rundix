const vscode = require("vscode"),
  fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
exports.run = async () => {
  const result = { inferencePerformed: false };
  const transport = require("../runtime/transport.cjs");
  const original = transport.findCli;
  try {
    // Simulate a clean machine while retaining a real VS Code host and native CLI.
    transport.findCli = () => {
      throw Error("Fixture: no system CLI");
    };
    const extension = vscode.extensions.getExtension(
      "local-rundix-tools.rundix",
    );
    const api = await extension.activate();
    const session = api.create();
    await api.connect();
    const executable = api.server().executable;
    assert.ok(
      executable.includes(
        path.join("globalStorage", "local-rundix-tools.rundix", "cli"),
      ),
    );
    assert.ok(fs.existsSync(executable));
    assert.ok(
      (await api.server().request("account/read", { refreshToken: false }))
        .account,
    );
    await api.handle(session, { action: "retry" });
    assert.equal(api.server().executable, executable);
    assert.equal(session.error, null);
    result.downloadedWithoutSystemCli = true;
    result.nativeAppServerConnected = true;
    result.reconnectUsesInstalledClient = true;
    result.passed = true;
    await api.closeTab(session);
  } catch (error) {
    result.passed = false;
    result.error = error.message;
  } finally {
    transport.findCli = original;
  }
  fs.writeFileSync(
    path.join(__dirname, "../.verification/cli-install-host.json"),
    JSON.stringify(result, null, 2),
  );
  if (!result.passed) throw Error(result.error);
};
