const fs = require("node:fs"),
  path = require("node:path");
const { randomUUID } = require("node:crypto");
const { install, layout, installed } = require("./cli-installer.cjs");
const versionPattern = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
async function releaseFor(
  channel,
  {
    platform = process.platform,
    arch = process.arch,
    fetchRequest = fetch,
  } = {},
) {
  if (!["stable", "alpha"].includes(channel))
    throw Error("Unknown CLI channel");
  async function json(url) {
    const response = await fetchRequest(url, {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("CLI registry unavailable");
    const body = await response.text();
    if (body.length > 1024 * 1024) throw Error("Oversized CLI metadata");
    return JSON.parse(body);
  }
  const tags = await json(
    "https://registry.npmjs.org/-/package/@openai%2fcodex/dist-tags",
  );
  const version = tags[channel === "stable" ? "latest" : "alpha"];
  if (
    typeof version !== "string" ||
    !versionPattern.test(version) ||
    (channel === "stable" && version.includes("-"))
  )
    throw Error("Invalid CLI release");
  const key = platform + "-" + arch;
  const core = await json(
    "https://registry.npmjs.org/@openai%2fcodex/" + encodeURIComponent(version),
  );
  const alias = core.optionalDependencies?.["@openai/codex-" + key];
  const packageVersion =
    typeof alias === "string" && alias.startsWith("npm:@openai/codex@")
      ? alias.slice("npm:@openai/codex@".length)
      : null;
  if (!packageVersion || !versionPattern.test(packageVersion))
    throw Error("CLI platform package unavailable");
  const pkg = await json(
    "https://registry.npmjs.org/@openai%2fcodex/" +
      encodeURIComponent(packageVersion),
  );
  const url = new URL(pkg.dist?.tarball);
  if (
    pkg.name !== "@openai/codex" ||
    pkg.version !== packageVersion ||
    url.protocol !== "https:" ||
    url.hostname !== "registry.npmjs.org" ||
    !url.pathname.startsWith("/@openai/codex/-/") ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.dist?.integrity || "")
  )
    throw Error("Untrusted CLI package");
  const release = {
    version,
    packages: { [key]: { url: url.href, integrity: pkg.dist.integrity } },
  };
  layout(".", platform, arch, release);
  return release;
}
class CliUpdates {
  constructor({
    root,
    platform = process.platform,
    arch = process.arch,
    fetchRequest = fetch,
    installer = install,
    now = Date.now,
  }) {
    Object.assign(this, { root, platform, arch, fetchRequest, installer, now });
    this.file = path.join(root, "updates.json");
    this.requests = new Map();
  }
  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }
  write(mutator) {
    const state = this.read();
    mutator(state);
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = this.file + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(state), { flag: "wx" });
      fs.renameSync(tmp, this.file);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
  current(channel) {
    const release = this.read().active?.[channel];
    if (!release) return null;
    try {
      const location = layout(this.root, this.platform, this.arch, release);
      return installed(location)
        ? { release, version: release.version, executable: location.executable }
        : null;
    } catch {
      return null;
    }
  }
  accept(channel, candidate) {
    this.write((state) => {
      state.active ||= {};
      state.active[channel] = candidate.release;
    });
  }
  reject(channel, candidate) {
    this.write((state) => {
      state.rejected ||= {};
      state.rejected[channel] = { version: candidate.version, at: this.now() };
    });
  }
  async prepare(channel, { force = false, onProgress = () => {} } = {}) {
    if (this.requests.has(channel)) return this.requests.get(channel);
    const request = (async () => {
      const state = this.read(),
        cached = state.releases?.[channel];
      const release =
        !force && cached && this.now() - cached.checkedAt < 3600000
          ? cached.release
          : await releaseFor(channel, this);
      if (release !== cached?.release)
        this.write((next) => {
          next.releases ||= {};
          next.releases[channel] = { release, checkedAt: this.now() };
        });
      const rejected = state.rejected?.[channel];
      if (
        !force &&
        rejected?.version === release.version &&
        this.now() - rejected.at < 21600000
      )
        throw Error("CLI release previously failed verification");
      const executable = await this.installer({
        root: this.root,
        platform: this.platform,
        arch: this.arch,
        fetchRequest: this.fetchRequest,
        release,
        onProgress,
      });
      return { release, version: release.version, executable };
    })();
    this.requests.set(channel, request);
    try {
      return await request;
    } finally {
      this.requests.delete(channel);
    }
  }
}
module.exports = { CliUpdates, releaseFor };
