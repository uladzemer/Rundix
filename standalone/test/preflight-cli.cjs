// Isolated, no inference and no real account/profile access.
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { AppServer, findCli } = require("../runtime/transport.cjs");
const { restrictedConfig } = require("../runtime/task-preflight.cjs");
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-cli-"));
  const marker = path.join(root, "mcp-started");
  const script = path.join(root, "fixture.cjs");
  fs.writeFileSync(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);`,
  );
  fs.writeFileSync(
    path.join(root, "config.toml"),
    `[mcp_servers."fixture.with.dot"]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(script)}]\nenabled = true\n`,
  );
  const client = new AppServer({
    executable: process.env.PREFLIGHT_CLI || findCli(),
    cwd: root,
    env: { ...process.env, CODEX_HOME: root },
  });
  client.on("disconnected", () => {});
  try {
    await client.start();
    const read = await client.request("config/read", {
      includeLayers: false,
      cwd: root,
    });
    assert.ok(read.config.mcp_servers["fixture.with.dot"]);
    const config = restrictedConfig(read.config);
    const result = await client.request("thread/start", {
      cwd: root,
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      config,
    });
    assert.ok(result.thread.id);
    assert.equal(fs.existsSync(marker), false, "Disabled MCP must not start");
    console.log(
      JSON.stringify({
        passed: true,
        inferencePerformed: false,
        realCli: true,
        disabledMcpDidNotStart: true,
        sandbox: result.sandbox,
      }),
    );
  } finally {
    const child = client.child;
    const closed = child
      ? new Promise((resolve) => child.once("close", resolve))
      : Promise.resolve();
    client.dispose();
    await closed;
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith("preflight-cli-")
    )
      throw Error("Unexpected fixture root");
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 100,
    });
  }
})().catch((error) => {
  console.error("Isolated preflight CLI check failed: " + (error.code || error.name));
  process.exitCode = 1;
});
