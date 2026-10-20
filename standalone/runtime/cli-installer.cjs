const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { findCli } = require("./transport.cjs");
const locale = require("../ui/i18n.js");
const manifest = require("./cli-manifest.json");
const run = promisify(execFile);
const triples = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
};
const pending = new Map();
function layout(root, platform, arch, release = manifest) {
  const key = platform + "-" + arch,
    triple = triples[key];
  if (
    !triple ||
    !release.packages[key] ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(release.version)
  )
    throw Error(
      locale.t(
        "Автоматическая установка Codex CLI для этой платформы недоступна.",
      ),
    );
  const directory = path.join(path.resolve(root), release.version + "-" + key);
  const relative = path.join(
    "vendor",
    triple,
    "bin",
    platform === "win32" ? "codex.exe" : "codex",
  );
  return {
    key,
    directory,
    relative,
    executable: path.join(directory, relative),
  };
}
function installed(location) {
  try {
    return (
      fs.statSync(path.join(location.directory, ".complete")).isFile() &&
      fs.statSync(location.executable).isFile()
    );
  } catch {
    return false;
  }
}
async function install({
  root,
  platform = process.platform,
  arch = process.arch,
  fetchRequest = fetch,
  extract,
  verify,
  onProgress = () => {},
  release = manifest,
}) {
  const location = layout(root, platform, arch, release);
  if (installed(location)) return location.executable;
  const rootPath = path.resolve(root);
  fs.mkdirSync(rootPath, { recursive: true });
  // Coordinate parallel VS Code windows without requiring a package manager.
  const lock = path.join(rootPath, location.key + ".lock");
  const nonce = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce }), {
        flag: "wx",
        mode: 0o600,
      });
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (installed(location)) return location.executable;
      try {
        const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw Error();
        try {
          process.kill(owner.pid, 0);
        } catch (e) {
          if (e.code === "ESRCH") {
            fs.unlinkSync(lock);
            continue;
          }
        }
      } catch {
        if (Date.now() - fs.statSync(lock).mtimeMs > 60000) {
          fs.unlinkSync(lock);
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!acquired)
    throw Error(
      locale.t(
        "Установка Codex CLI уже выполняется в другом окне. Повторите подключение позже.",
      ),
    );
  const stage = path.join(rootPath, ".install-" + nonce);
  try {
    if (installed(location)) return location.executable;
    fs.mkdirSync(stage);
    const archive = path.join(stage, "download.tgz");
    const pkg = release.packages[location.key];
    const url = new URL(pkg.url);
    if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org")
      throw Error("Invalid CLI source");
    onProgress(locale.t("Загрузка официального Codex CLI…"));
    const response = await fetchRequest(url.href, {
      redirect: "error",
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok || !response.body)
      throw Error(
        locale.t(
          "Не удалось скачать Codex CLI. Проверьте подключение к интернету и нажмите «Переподключиться».",
        ),
      );
    const hash = createHash("sha512");
    let bytes = 0;
    const check = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > 350 * 1024 * 1024)
          return callback(Error("CLI archive size exceeded"));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      check,
      fs.createWriteStream(archive, { flags: "wx" }),
    );
    if ("sha512-" + hash.digest("base64") !== pkg.integrity)
      throw Error(
        locale.t("Контрольная сумма Codex CLI не совпала. Установка отменена."),
      );
    onProgress(locale.t("Установка Codex CLI…"));
    const unpack = path.join(stage, "unpacked");
    fs.mkdirSync(unpack);
    let total = 0,
      unsafe = false;
    const options = {
      file: archive,
      cwd: unpack,
      strip: 1,
      strict: true,
      preservePaths: false,
      filter: (name, entry) => {
        if (
          name.includes("\\") ||
          name.split("/").includes("..") ||
          !name.startsWith("package/") ||
          !["File", "Directory"].includes(entry.type)
        ) {
          unsafe = true;
          return false;
        }
        total += entry.size || 0;
        if (total > 1200 * 1024 * 1024) {
          unsafe = true;
          return false;
        }
        return true;
      },
    };
    await (extract || require("./archive.cjs").x)(options);
    if (unsafe) throw Error("Unsafe CLI archive");
    const binary = path.join(unpack, location.relative);
    if (!fs.statSync(binary).isFile()) throw Error("CLI executable missing");
    if (platform !== "win32") fs.chmodSync(binary, 0o755);
    await (
      verify ||
      (async (executable) => {
        const result = await run(executable, ["--version"], {
          windowsHide: true,
          timeout: 20000,
          maxBuffer: 65536,
        });
        if (result.stdout.trim() !== "codex-cli " + release.version)
          throw Error("CLI version mismatch");
      })
    )(binary);
    fs.writeFileSync(path.join(unpack, ".complete"), release.version);
    // Quarantine only the exact managed version under the install lock, after
    // its replacement has passed verification. Stage cleanup removes it safely.
    const broken = path.join(stage, "broken");
    if (fs.existsSync(location.directory)) fs.renameSync(location.directory, broken);
    try { fs.renameSync(unpack, location.directory); }
    catch (error) {
      if (fs.existsSync(broken)) fs.renameSync(broken, location.directory);
      throw error;
    }
    return location.executable;
  } catch (error) {
    // Keep credentials and arbitrary process output out of UI errors.
    if (
      /^(Не удалось скачать|Контрольная сумма|Could not download|Codex CLI checksum)/.test(
        error.message,
      )
    )
      throw error;
    throw Error(
      locale.t(
        "Не удалось установить Codex CLI. Проверьте сеть и доступное место на диске, затем нажмите «Переподключиться».",
      ),
    );
  } finally {
    // Only remove the exact staging directory created by this invocation.
    if (
      path.dirname(stage) === rootPath &&
      path.basename(stage) === ".install-" + nonce
    )
      // Cleanup is best effort: a locked file in the old broken copy must not mask a successful install.
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    try {
      if (JSON.parse(fs.readFileSync(lock, "utf8")).nonce === nonce)
        fs.unlinkSync(lock);
    } catch {}
  }
}
async function ensureCli({
  configured = "",
  root,
  find = findCli,
  ...options
}) {
  if (configured) return find(configured); // An explicit bad path must not trigger a replacement.
  try {
    return find();
  } catch {}
  const key = path.resolve(root);
  if (pending.has(key)) return pending.get(key);
  const request = install({ root, ...options });
  pending.set(key, request);
  try {
    return await request;
  } finally {
    pending.delete(key);
  }
}
module.exports = { ensureCli, install, layout, installed };
