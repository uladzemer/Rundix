const vscode = require("vscode"),
  fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
exports.run = async () => {
  const result = { inferencePerformed: false };
  const { CliUpdates } = require("../runtime/cli-updates.cjs");
  let original;
  try {
    await vscode.workspace
      .getConfiguration("rundix")
      .update("cliChannel", "stable", vscode.ConfigurationTarget.Global);
    const api = await vscode.extensions
      .getExtension("local-rundix-tools.rundix")
      .activate();
    const session = api.create();
    await api.connect();
    await api.handle(session, {
      action: "draft",
      text: "Update fixture draft",
    });
    const before = api.server().executable;
    session.busy = true;
    await api.checkCliUpdates(true);
    assert.equal(api.server().executable, before);
    session.busy = false;
    await api.checkCliUpdates(true);
    assert.ok(
      api
        .server()
        .executable.includes(
          path.join(
            "globalStorage",
            "local-rundix-tools.rundix",
            "cli",
          ),
        ),
    );
    assert.equal(session.draft, "Update fixture draft");
    result.appliedOnlyWhileIdle = true;
    const states = [];
    const post = api.view(session).panel.webview.postMessage.bind(api.view(session).panel.webview);
    api.view(session).panel.webview.postMessage = (message) => {
      if (message.type === "state") states.push(message.data);
      return post(message);
    };
    await api.handle(session, { action: "models" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const native = await api
      .server()
      .request("model/list", { limit: 100, includeHidden: false });
    const published = states.at(-1);
    assert.ok(published);
    assert.deepEqual(
      published.models.map((m) => m.model),
      native.data.map((m) => m.model),
    );
    result.modelsMatchOfficialClient = true;
    result.version = published.cli.version;
    const good = api.server().executable;
    original = CliUpdates.prototype.prepare;
    CliUpdates.prototype.prepare = async () => ({
      version: "0.0.0-test",
      release: {},
      executable: path.join(__dirname, "missing-cli-fixture.exe"),
    });
    await api.checkCliUpdates(true);
    assert.equal(api.server().executable, good);
    assert.ok(
      (await api.server().request("account/read", { refreshToken: false }))
        .account,
    );
    result.failedUpdateRestoresPreviousClient = true;
    result.passed = true;
    await api.closeTab(session);
  } catch (error) {
    result.passed = false;
    result.error = error.message;
  } finally {
    if (original) CliUpdates.prototype.prepare = original;
  }
  fs.writeFileSync(
    path.join(__dirname, "../.verification/cli-updates-host.json"),
    JSON.stringify(result, null, 2),
  );
  if (!result.passed) throw Error(result.error);
};
