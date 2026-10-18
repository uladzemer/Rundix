const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { CliUpdates, releaseFor } = require("../runtime/cli-updates.cjs");
const { layout } = require("../runtime/cli-installer.cjs");
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-updates-test-"));
  let now = 1000000,
    requests = 0,
    installs = 0,
    attack = false;
  const fetchRequest = async (url) => {
    requests++;
    const value = url.endsWith("dist-tags")
      ? { latest: "1.2.3", alpha: "1.3.0-alpha.4" }
      : url.endsWith("1.2.3") || url.endsWith("1.3.0-alpha.4")
        ? {
            optionalDependencies: {
              "@openai/codex-win32-x64":
                "npm:@openai/codex@" +
                (url.endsWith("1.2.3") ? "1.2.3" : "1.3.0-alpha.4") +
                "-win32-x64",
            },
          }
        : {
            name: "@openai/codex",
            version: decodeURIComponent(url.split("/").at(-1)),
            dist: {
              tarball: attack
                ? "https://example.test/malware.tgz"
                : "https://registry.npmjs.org/@openai/codex/-/fixture.tgz",
              integrity: "sha512-" + "A".repeat(86) + "==",
            },
          };
    return new Response(JSON.stringify(value));
  };
  const updater = new CliUpdates({
    root,
    platform: "win32",
    arch: "x64",
    now: () => now,
    fetchRequest,
    installer: async (options) => {
      installs++;
      const target = layout(root, "win32", "x64", options.release);
      fs.mkdirSync(path.dirname(target.executable), { recursive: true });
      fs.writeFileSync(target.executable, "fixture");
      fs.writeFileSync(path.join(target.directory, ".complete"), "fixture");
      return target.executable;
    },
  });
  try {
    const first = await updater.prepare("stable");
    assert.equal(first.version, "1.2.3");
    assert.equal(
      updater.current("stable"),
      null,
      "Not activated before app-server verification",
    );
    updater.accept("stable", first);
    assert.equal(updater.current("stable").version, "1.2.3");
    const before = requests;
    now += 1000;
    await updater.prepare("stable");
    assert.equal(requests, before);
    now += 3600000;
    await updater.prepare("stable");
    assert.ok(requests > before, "Cache expires instead of sliding forever");
    const alpha = await updater.prepare("alpha");
    assert.equal(alpha.version, "1.3.0-alpha.4");
    updater.accept("alpha", alpha);
    assert.equal(
      updater.current("stable").version,
      "1.2.3",
      "Channels retain independent installations",
    );
    updater.reject("alpha", alpha);
    await assert.rejects(updater.prepare("alpha"), /previously failed/);
    await updater.prepare("alpha", { force: true });
    assert.equal(
      updater.current("stable").version,
      "1.2.3",
      "Failed candidate never replaces accepted client",
    );
    attack = true;
    await assert.rejects(
      releaseFor("stable", { platform: "win32", arch: "x64", fetchRequest }),
      /Untrusted/,
    );
    await assert.rejects(releaseFor("garbage", { fetchRequest }), /Unknown/);
    assert.ok(installs >= 3);
    console.log(
      "PASS: stable/alpha resolution, verified registry sources, fixed cache TTL, independent channel installs, deferred activation, failed-release backoff and forced retry.",
    );
  } finally {
    if (
      path.dirname(root) === fs.realpathSync(os.tmpdir()) &&
      path.basename(root).startsWith("codex-updates-test-")
    )
      fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
