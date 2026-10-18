# Local edition boundary and validation

The local edition started with a fresh repository history and a separate extension identity: `local-rundix-tools.rundix`, initial version `0.1.0`, command/configuration prefix `rundix`. It does not migrate the personal edition's sessions or settings automatically. Version 0.2.0 adds a generic optional connection API; see [connection-api.md](connection-api.md). Provider implementations remain outside the public package, and local CLI sign-in is still the default.

Authentication stays with the official CLI. The host requests public account information with `account/read` and `{refreshToken:false}`, reads official usage snapshots and can start/cancel the official browser sign-in. It does not read or copy credential files. Account pools, saved-profile management, file imports, account rotation, cloud authentication and the broker/admin/server project are absent. CLI/model endpoints and explicitly configured optional notifications remain.

The current account name is displayed directly in the account menu and account label. This local edition has no name-masking toggle.

The `{R}` mark and simple action SVG paths are project assets under MIT. Bundled library notices are preserved. This is technical preparation for distribution, not a trademark clearance or a Marketplace publication.

## Checks on 18 October 2026

- `npm.cmd test`: synthetic runtime/contract tests passed.
- `npm.cmd run test:browser`: passed; screenshots inspected for the local account menu and light/dark, narrow/wide layouts.
- `powershell -NoProfile -File test/host.ps1 -TestFile local-auth-host.cjs`: passed in an isolated VS Code profile with a synthetic transport and synthetic authentication fixture. Signed-out and exhausted-account requests preserved drafts; a failed status read recovered; credential fixture remained unchanged.
- `powershell -NoProfile -File test/host.ps1 -TestFile startup-host.cjs`: passed; first/warm sends, account and quota reads, questions, task preparation and queue behavior used synthetic RPCs.
- `npm.cmd run package`: built the VSIX; ZIP audit passed for 78 entries. All 76 extension files were compared with their source files, including the separate identity.
- Source files were scanned for credential, private deployment URL and personal source-path patterns; none detected. Pattern scans cannot prove the absence of every possible secret.
- A separate read-only reviewer checked the changed authentication/runtime/UI boundary. A metadata wording issue was fixed; no confirmed remaining regressions were reported.

The initial validation did not perform a real model request, real sign-in change or installation over the owner's personal edition. CLI/OS credential-store compatibility remains the responsibility of the installed CLI and needs platform testing before a public release.

Before the public 0.1.1 release, tracked source, the publication history and the VSIX were rechecked for credentials, private deployment URLs and personal links. Gitleaks' two initial matches were fixed storage-key identifiers, not credentials; `.gitleaks.toml` allows only those exact values in their specific source file. Public Git history uses the owner's GitHub noreply address; earlier local commits with a personal author email are not published.

See [../../UPSTREAM.md](../../UPSTREAM.md) for carrying shared improvements into this edition. Synchronization is currently manual.
