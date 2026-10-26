# Rundix — local CLI edition

This repository contains the common Rundix extension. Local sign-in belongs to the official Codex CLI on the user's computer. Optional installed companion extensions can supply a connection through the versioned API described in `standalone/docs/connection-api.md`. Never add a companion's account pool, token extraction, credential-file imports, private authentication endpoints or rotation implementation to this public repository. Generic lifecycle hooks are allowed; absence of a selected companion must fail closed.

Read `git status`, relevant source and `REVIEW.md` before changing behavior. Preserve unrelated edits. Keep the host in `standalone/extension.cjs`, protocol/state/files in `standalone/runtime/`, and rendering/input in `standalone/ui/`. New independent logic belongs in a focused module. Runtime uses CommonJS; UI uses the current browser script setup.

User data, tokens, credentials, chat text and personal paths must not enter logs, test fixtures, commits or packages. Use explicitly synthetic data in tests. Do not change the user's sign-in to test the extension. Ask the CLI for account information; do not read authentication files or request raw tokens. Keep async results scoped to their owning session, account and server instance. Use bounded RPC/network timeouts and preserve drafts on failure.

The extension ID is `local-rundix-tools.rundix`, with `rundix` commands and settings. Do not change published identifiers without a compatibility plan. The icon is `{R}`; source is in `standalone/resources/` and `standalone/resources/branding/`.

Checks, from `standalone/`:

GitHub Actions are disabled in repository settings at the owner's request on 18 October 2026. Keep workflows for possible future use, but do not re-enable Actions without a request. Run the appropriate checks locally.

- `npm.cmd test`: synthetic runtime and contract checks.
- `npm.cmd run test:browser`: Chrome UI checks. Set `CHROME_PATH` when needed; inspect visible changes in both themes and narrow/wide panels, in Russian and English.
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/host.ps1 -TestFile local-auth-host.cjs`: isolated synthetic Extension Host authentication checks.
- `npm.cmd run package`: build `rundix-<version>.vsix` and audit the actual ZIP. Inspect packaged source, identity, README and icons before distribution.

Use `REVIEW.md` for a separate correctness/security review; substantial runtime/UI changes need a read-only reviewer with fresh context when available. Review at most three rounds, focusing later rounds on fixes and affected paths. Do not call self-review independent review.

Commit completed changes after checks, staging only relevant files. Push only to a remote actually configured for this clean repository. Never attach the private source project's remote or history. Repository publication and Marketplace publication require an explicit request. Marketplace publishing uses Microsoft Entra ID through `standalone/scripts/marketplace.ps1` (`status`, `login`, `publish`, `id`); the tenant ID stays in the untracked `marketplace.local.json` beside it. Do not install this edition over another edition or change the user's VS Code settings outside this extension.

Keep reviewable local changes and explain missing information or concrete blockers. Final responses use four short Russian sections: «Что было задано», «Что я решил», «Что не удалось», «Что бы я ещё сделал». The last section includes at least three concrete optional suggestions with 🔴 / 🟡 / 🟢 circles in priority order; do not invent urgency.

Local-edition boundaries and the initial validation level are recorded in `standalone/docs/local-edition.md`. Porting shared improvements is described in `UPSTREAM.md`; automatic synchronization is not implemented.
