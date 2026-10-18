const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createHash } = require("node:crypto");
const { ensureCli, install, layout } = require("../runtime/cli-installer.cjs");
const manifest = require("../runtime/cli-manifest.json");
(async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-cli-install-test-"),
  );
  const original = manifest.packages["win32-x64"];
  try {
    const payload = Buffer.from("synthetic archive fixture");
    manifest.packages["win32-x64"] = {
      url: original.url,
      integrity:
        "sha512-" + createHash("sha512").update(payload).digest("base64"),
    };
    let downloads = 0,
      checks = 0;
    const options = {
      root,
      platform: "win32",
      arch: "x64",
      find: () => {
        throw Error("CLI absent");
      },
      fetchRequest: async () => {
        downloads++;
        return new Response(payload);
      },
      extract: async (settings) => {
        assert.equal(settings.strip, 1);
        assert.ok(
          settings.filter("package/vendor/file", { type: "File", size: 10 }),
        );
        const file = path.join(
          settings.cwd,
          layout(root, "win32", "x64").relative,
        );
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "fixture executable");
      },
      verify: async (file) => {
        checks++;
        assert.equal(fs.readFileSync(file, "utf8"), "fixture executable");
      },
    };
    assert.equal(
      await ensureCli({ ...options, find: () => "/existing/codex" }),
      "/existing/codex",
    );
    assert.equal(downloads, 0);
    await assert.rejects(
      ensureCli({ ...options, configured: "/bad/path" }),
      /CLI absent/,
    );
    assert.equal(downloads, 0);
    const [a, b] = await Promise.all([ensureCli(options), ensureCli(options)]);
    assert.equal(a, b);
    assert.equal(downloads, 1);
    assert.equal(checks, 1);
    assert.ok(fs.existsSync(a));
    assert.equal(await install(options), a);
    assert.equal(downloads, 1);
    assert.ok(
      !fs
        .readdirSync(root)
        .some((name) => name.endsWith(".lock") || name.startsWith(".install-")),
    );
    const invalid = {
      ...options,
      root: path.join(root, "invalid"),
      fetchRequest: async () => new Response("corrupt"),
    };
    await assert.rejects(install(invalid), /Контрольная сумма/);
    assert.deepEqual(
      fs.readdirSync(invalid.root),
      [],
      "Failed download leaves no usable install or lock",
    );
    const unsafe = {
      ...options,
      root: path.join(root, "unsafe"),
      extract: async (settings) => {
        assert.equal(
          settings.filter("package/../../escape", { type: "File", size: 10 }),
          false,
        );
        assert.equal(
          settings.filter("package/symlink", { type: "SymbolicLink", size: 0 }),
          false,
        );
      },
    };
    await assert.rejects(install(unsafe), /Не удалось установить/);
    assert.deepEqual(fs.readdirSync(unsafe.root), []);
    await assert.rejects(
      install({
        ...options,
        root: path.join(root, "network"),
        fetchRequest: async () => {
          throw Error("network failure");
        },
      }),
      /Не удалось установить/,
    );
    for (const platform of ["win32", "darwin", "linux"])
      for (const arch of ["x64", "arm64"]) {
        const location = layout(root, platform, arch);
        assert.ok(location.executable.includes("vendor"));
        assert.ok(
          manifest.packages[location.key].integrity.startsWith("sha512-"),
        );
      }
    assert.throws(() => layout(root, "unsupported", "x64"), /платформы/);
    console.log(
      "PASS: managed CLI installation, existing/custom clients, concurrent requests, cache, pinned checksums, archive boundaries, network recovery and six platform layouts.",
    );
  } finally {
    manifest.packages["win32-x64"] = original;
    if (
      path.dirname(root) === fs.realpathSync(os.tmpdir()) &&
      path.basename(root).startsWith("codex-cli-install-test-")
    )
      fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
