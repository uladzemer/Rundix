// Service children never inherit repository/tool credentials from their caller.
// Keep this allowlist shared across the launcher, provider and Codex CLI.
function serviceEnvironment(source = process.env) {
  const allowed = /^(?:RUNDIX_SERVICE_ROOT|RUNDIX_PROVIDER_CONFIG_DIR|RUNDIX_SERVICE_ENDPOINT_NAMESPACE|ProgramFiles(?:\(x86\))?|ProgramW6432|ProgramData|SystemDrive|USERNAME|USERDOMAIN|HOMEDRIVE|HOMEPATH|PSModulePath|ALLUSERSPROFILE|PUBLIC|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|TMPDIR|SHELL|USER|LOGNAME|XDG_[A-Z0-9_]+|SSL_CERT_FILE|SSL_CERT_DIR|ALL_PROXY|PATH|SystemRoot|windir|COMSPEC|PATHEXT|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|TEMP|TMP|CODEX_HOME|LANG|LC_[A-Z0-9_]+|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY)$/i;
  return {...Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.test(key) && typeof value === 'string')),
    ELECTRON_RUN_AS_NODE:'1'};
}
module.exports = {serviceEnvironment};
