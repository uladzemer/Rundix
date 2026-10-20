# External CLI authentication verification — 2026-10-20

## Result

**1 confirmed safety finding; verdict: UNSAFE with the default/file credential store.**
The claim including logout is false for both installed binaries: pinned/PATH Codex
0.159.2 and Rundix-managed Codex 0.163.0. After external login, `account/logout`
**deletes the existing synthetic `CODEX_HOME/auth.json`**. This blocks relying on
external-token login alone to protect a user's normal home. It is upstream CLI
behavior, not a regression introduced by this test.

**Conditionally safe for the credential-isolation property tested here:** start
the service process with `-c 'cli_auth_credentials_store="ephemeral"'`. Both
versions then preserve the sentinel, including logout. Use a process argument;
do not edit the user's global config. File and keyring/auto are not substitutes
for ephemeral. Retain the hard turn gate, scoped to the current process/account,
and reset it after every server restart. Do not inherit credential environment
overrides or expose other persistent-login/config mutation RPCs through the gate.
This is a bounded source-and-synthetic verification, not certification of every
operation possible in a normal Codex home.

## Source evidence

Read directly from shallow checkouts of the official tags, outside this repository.
The manifest pins `0.159.2`. The tag's commit is
`ff6aec96948b70d94983af2641a6b67c94faeff5`; the `0.163.0` tag's commit is
`83086188ae0614bd882818ff1aa23f3194962012`.

- External login constructs `CodexAuth::from_external_chatgpt_tokens` and installs
  an `ExternalAuthBridge`, without a managed-login save:
  [account_processor.rs, 831–884](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/src/request_processors/account_processor.rs#L831-L884).
- Installation resolves the provider and commits external auth:
  [manager.rs, 2663–2707](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/auth/manager.rs#L2663-L2707).
  Refresh commits through the same path, explicitly choosing **Ephemeral**,
  independently of the configured persistent store:
  [manager.rs, 3028–3074](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/auth/manager.rs#L3028-L3074).
  That backend is a process-local map; its save/delete do not call file or keyring
  operations:
  [storage.rs, 460–500](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/auth/storage.rs#L460-L500).
- While an external provider is installed, auth reload returns through that
  provider's branch even on resolution failure; it does not continue into the
  persistent-store branch:
  [manager.rs, 2576–2630](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/auth/manager.rs#L2576-L2630).
  The general loader checks the ephemeral map before persistent storage and
  explicitly suppresses persistent fallback when configured ephemeral. Credential
  environment overrides have their own precedence, so these must also be
  controlled in the service environment:
  [manager.rs, 1488–1582](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/auth/manager.rs#L1488-L1582).
- `account/read {refreshToken:true}` deliberately skips refresh for external
  ChatGPT auth:
  [account_processor.rs, 1026–1038](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/src/request_processors/account_processor.rs#L1026-L1038).
  Real external refresh is the server-to-client
  `account/chatgptAuthTokens/refresh` request, with a 10-second timeout and
  in-memory replacement:
  [external_auth.rs, 17–86](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/src/external_auth.rs#L17-L86).
- **Counterexample:** `account/logout` calls `logout_with_revoke`:
  [account_processor.rs, 964–1000](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/app-server/src/request_processors/account_processor.rs#L964-L1000).
  That calls `logout_all_stores`, clears external auth, and reloads:
  [manager.rs, 2959–2977](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/auth/manager.rs#L2959-L2977).
  Only configured **ephemeral** avoids deleting the configured persistent store:
  [manager.rs, 1462–1486](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/auth/manager.rs#L1462-L1486).
- File delete removes `auth.json`:
  [storage.rs, 154–165](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/auth/storage.rs#L154-L165)
  and [225–227](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/auth/storage.rs#L225-L227).
  Direct keyring delete removes its entry and the fallback file:
  [312–322](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/auth/storage.rs#L312-L322).
  The secrets backend deletes its secret and direct-store fallback:
  [393–405](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/auth/storage.rs#L393-L405).
  Auto delegates deletion to the keyring backend:
  [453–457](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/login/src/auth/storage.rs#L453-L457).
  Thus a temp home alone does not justify running a real OS-keyring test.
- The default store is **File**; available modes are file, keyring, auto,
  ephemeral:
  [config/types.rs, 112–126](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/config/src/types.rs#L112-L126).
- The same relevant paths were read at 0.163.0:
  [login handler, 856–910](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/request_processors/account_processor.rs#L856-L910),
  [load_auth, 2574–2628](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/login/src/auth/manager.rs#L2574-L2628),
  [logout_all_stores, 1463–1487](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/login/src/auth/manager.rs#L1463-L1487),
  [logout, 2956–2977](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/login/src/auth/manager.rs#L2956-L2977),
  [external commit, 3052–3074](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/login/src/auth/manager.rs#L3052-L3074).

## Test and limits

`npm.cmd run test:cli-auth` is opt-in; it is not part of `npm.cmd test`.
`RUNDIX_TEST_CODEX` selects a native executable. Otherwise discovery tries the
Rundix-managed installation and then PATH/the standard Windows npm native binary.
An unavailable executable prints SKIP and exits 0. Bounded RPC timeout prints an
inconclusive SKIP; previously detected invariant failures still exit 1.
`RUNDIX_TEST_AUTH_STORE=ephemeral` selects the additional isolation scenario;
file is the default. Keyring and auto are intentionally rejected.

The test asserts that the newly created CODEX_HOME resolves inside `os.tmpdir()`.
It overrides HOME/USERPROFILE, application/XDG/temp paths, uses a whitelist
environment, a neutral temporary cwd, and refuses executable discovery inside
the real Codex home. It never reads, copies, prints or changes real auth files,
and never logs the real CLI in or out. Only the installed executable is used.
No real home contents or sign-in state are used as a baseline.

The sentinel contains an obviously synthetic API key, making startup account
selection distinguishable from external ChatGPT auth. External tokens are unsigned
synthetic JWT-shaped strings with synthetic claims. A loopback HTTP fixture
provides accounts/config responses and intentional 401s; no internet service or
inference is required. Other HTTP(S) traffic is directed at a closed loopback proxy.
The discovered routing origin is the reserved `synthetic.invalid` domain.
The probe discards CLI stderr, logs only synthetic account observations and coded
RPC errors, and removes its temporary tree after stopping the process.

Checkpoints compare sentinel bytes and nanosecond mtime and scan for newly named
auth/credential/token/secret/keyring files. This filename scan is not proof against
credential material hidden under arbitrary filenames; source analysis supplies
the storage-path evidence. The test covers graceful stdin close/process restart,
not OS crash or every CLI RPC. Real OS-keyring behavior is source-reviewed only.
The sentinel is API-key-shaped JSON, so migrations/refresh of legacy persisted
ChatGPT auth formats are outside this test. No runtime/UI behavior was changed.

## Actual results

Windows, installed native binaries, real app-server without inference:

| Binary | Store | Result | Exit |
| --- | --- | --- | --- |
| PATH/npm 0.159.2 (manifest pin) | file | FAIL: sentinel deleted by logout | 1 |
| Rundix-managed 0.163.0 | file | FAIL: sentinel deleted by logout | 1 |
| PATH/npm 0.159.2 | ephemeral | PASS | 0 |
| Rundix-managed 0.163.0 | ephemeral | PASS | 0 |

In both versions, file mode reports `account.type=apiKey` before external login
and again after restart. After external login it reports `type=chatgpt`, synthetic
external email and plus plan. Ephemeral reports `account=null` before login and
after restart. This distinguishes credential presence from authorization to send:
`account/read` alone cannot replace the service's hard turn gate.

For both stores, login, explicit read, successful refresh callback, failed refresh
callback, and process exit preserve the sentinel. Local 401 discovery returns RPC
`-32603` after the bounded recovery attempt; restoration of the local fixture
returns the external account, never the file's account. `refreshToken=true` causes
zero external refresh requests, as documented in source. File-mode logout then
returns `account=null` and removes the sentinel; ephemeral logout preserves it.

`npm.cmd test`: PASS, exit 0. Targeted author review followed REVIEW.md against
the uncommitted test/script/report changes; this is not an independent review.
`node --check test/cli-external-auth.cjs` and `git diff --check`: PASS.
An explicit nonexistent temporary executable path produced
`SKIP Codex CLI unavailable`, exit 0.
No commit, push, installation, settings change or publication was performed.

The following blocks contain the actual final probe output (no personal paths).

### pinned / file

```text
CLI codex-cli 0.159.2; isolated synthetic home; credential store=file
OBSERVE before external login: {"account":{"type":"apiKey"},"requiresOpenaiAuth":true,"workspaceRouting":null}
PASS startup account matches configured credential store
PASS startup preserves sentinel bytes + mtime
OBSERVE after external login: {"account":{"type":"chatgpt","email":"external@synthetic.invalid","planType":"plus"},"requiresOpenaiAuth":true,"workspaceRouting":{"chatgptAccountId":"synthetic-external","backendOrigin":"https://synthetic.invalid","accountRoutingOverride":"NO_CONSTRAINT"}}
PASS external login selects external synthetic account
PASS external login preserves sentinel bytes + mtime
OBSERVE account/read refreshToken=true: 0 external refresh requests
PASS account/read refresh preserves sentinel bytes + mtime
OBSERVE local 401 (successful refresh): RPC error code -32603
PASS successful external refresh callback exercised
PASS no stored-account fallback after successful external refresh
PASS external refresh (success) preserves sentinel bytes + mtime
OBSERVE local 401 (failed refresh): RPC error code -32603
PASS failed external refresh callback exercised
PASS no stored-account fallback after failed external refresh
PASS external refresh (failure) preserves sentinel bytes + mtime
PASS process exit preserves sentinel bytes + mtime
OBSERVE after restart: {"account":{"type":"apiKey"},"requiresOpenaiAuth":true,"workspaceRouting":null}
PASS restart account matches configured store (gate must reset)
OBSERVE after external logout: {"account":null,"requiresOpenaiAuth":true,"workspaceRouting":null}
OBSERVE sentinel after logout: DELETED
FAIL logout preserves sentinel bytes + mtime
FAIL exit after logout preserves sentinel bytes + mtime
PASS no new credential-like files
OBSERVE 68 new non-baseline files; 0 credential-like files; OS keyring NOT exercised (forced file)
FAIL codex-cli 0.159.2 store=file: 2 violated assertions
Exit code: 1
```

### managed / file

```text
CLI codex-cli 0.163.0; isolated synthetic home; credential store=file
OBSERVE before external login: {"account":{"type":"apiKey"},"requiresOpenaiAuth":true,"workspaceRouting":null}
PASS startup account matches configured credential store
PASS startup preserves sentinel bytes + mtime
OBSERVE after external login: {"account":{"type":"chatgpt","email":"external@synthetic.invalid","planType":"plus"},"requiresOpenaiAuth":true,"workspaceRouting":{"chatgptAccountId":"synthetic-external","backendOrigin":"https://synthetic.invalid","accountRoutingOverride":"NO_CONSTRAINT"}}
PASS external login selects external synthetic account
PASS external login preserves sentinel bytes + mtime
OBSERVE account/read refreshToken=true: 0 external refresh requests
PASS account/read refresh preserves sentinel bytes + mtime
OBSERVE local 401 (successful refresh): RPC error code -32603
PASS successful external refresh callback exercised
PASS no stored-account fallback after successful external refresh
PASS external refresh (success) preserves sentinel bytes + mtime
OBSERVE local 401 (failed refresh): RPC error code -32603
PASS failed external refresh callback exercised
PASS no stored-account fallback after failed external refresh
PASS external refresh (failure) preserves sentinel bytes + mtime
PASS process exit preserves sentinel bytes + mtime
OBSERVE after restart: {"account":{"type":"apiKey"},"requiresOpenaiAuth":true,"workspaceRouting":null}
PASS restart account matches configured store (gate must reset)
OBSERVE after external logout: {"account":null,"requiresOpenaiAuth":true,"workspaceRouting":null}
OBSERVE sentinel after logout: DELETED
FAIL logout preserves sentinel bytes + mtime
FAIL exit after logout preserves sentinel bytes + mtime
PASS no new credential-like files
OBSERVE 69 new non-baseline files; 0 credential-like files; OS keyring NOT exercised (forced file)
FAIL codex-cli 0.163.0 store=file: 2 violated assertions
Exit code: 1
```

### pinned / ephemeral

```text
CLI codex-cli 0.159.2; isolated synthetic home; credential store=ephemeral
OBSERVE before external login: {"account":null,"requiresOpenaiAuth":true,"workspaceRouting":null}
PASS startup account matches configured credential store
PASS startup preserves sentinel bytes + mtime
OBSERVE after external login: {"account":{"type":"chatgpt","email":"external@synthetic.invalid","planType":"plus"},"requiresOpenaiAuth":true,"workspaceRouting":{"chatgptAccountId":"synthetic-external","backendOrigin":"https://synthetic.invalid","accountRoutingOverride":"NO_CONSTRAINT"}}
PASS external login selects external synthetic account
PASS external login preserves sentinel bytes + mtime
OBSERVE account/read refreshToken=true: 0 external refresh requests
PASS account/read refresh preserves sentinel bytes + mtime
OBSERVE local 401 (successful refresh): RPC error code -32603
PASS successful external refresh callback exercised
PASS no stored-account fallback after successful external refresh
PASS external refresh (success) preserves sentinel bytes + mtime
OBSERVE local 401 (failed refresh): RPC error code -32603
PASS failed external refresh callback exercised
PASS no stored-account fallback after failed external refresh
PASS external refresh (failure) preserves sentinel bytes + mtime
PASS process exit preserves sentinel bytes + mtime
OBSERVE after restart: {"account":null,"requiresOpenaiAuth":true,"workspaceRouting":null}
PASS restart account matches configured store (gate must reset)
OBSERVE after external logout: {"account":null,"requiresOpenaiAuth":true,"workspaceRouting":null}
OBSERVE sentinel after logout: present
PASS logout preserves sentinel bytes + mtime
PASS exit after logout preserves sentinel bytes + mtime
PASS no new credential-like files
OBSERVE 68 new non-baseline files; 0 credential-like files; OS keyring NOT exercised (forced ephemeral)
PASS codex-cli 0.159.2 store=ephemeral: 0 violated assertions
Exit code: 0
```

### managed / ephemeral

```text
CLI codex-cli 0.163.0; isolated synthetic home; credential store=ephemeral
OBSERVE before external login: {"account":null,"requiresOpenaiAuth":true,"workspaceRouting":null}
PASS startup account matches configured credential store
PASS startup preserves sentinel bytes + mtime
OBSERVE after external login: {"account":{"type":"chatgpt","email":"external@synthetic.invalid","planType":"plus"},"requiresOpenaiAuth":true,"workspaceRouting":{"chatgptAccountId":"synthetic-external","backendOrigin":"https://synthetic.invalid","accountRoutingOverride":"NO_CONSTRAINT"}}
PASS external login selects external synthetic account
PASS external login preserves sentinel bytes + mtime
OBSERVE account/read refreshToken=true: 0 external refresh requests
PASS account/read refresh preserves sentinel bytes + mtime
OBSERVE local 401 (successful refresh): RPC error code -32603
PASS successful external refresh callback exercised
PASS no stored-account fallback after successful external refresh
PASS external refresh (success) preserves sentinel bytes + mtime
OBSERVE local 401 (failed refresh): RPC error code -32603
PASS failed external refresh callback exercised
PASS no stored-account fallback after failed external refresh
PASS external refresh (failure) preserves sentinel bytes + mtime
PASS process exit preserves sentinel bytes + mtime
OBSERVE after restart: {"account":null,"requiresOpenaiAuth":true,"workspaceRouting":null}
PASS restart account matches configured store (gate must reset)
OBSERVE after external logout: {"account":null,"requiresOpenaiAuth":true,"workspaceRouting":null}
OBSERVE sentinel after logout: present
PASS logout preserves sentinel bytes + mtime
PASS exit after logout preserves sentinel bytes + mtime
PASS no new credential-like files
OBSERVE 69 new non-baseline files; 0 credential-like files; OS keyring NOT exercised (forced ephemeral)
PASS codex-cli 0.163.0 store=ephemeral: 0 violated assertions
Exit code: 0
```
