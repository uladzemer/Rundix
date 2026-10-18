# Maintaining the local edition

This repository starts with a fresh Git history. Its source baseline is the Rundix personal edition at commit `5e792c0` (18 October 2026), with private authentication and server features removed. No upstream remote is configured.

Shared UI and CLI improvements can be ported as small, reviewed patches. Apply only changes relevant to the local edition; inspect imports, settings, network destinations, tests and documentation before committing. Never merge the private repository's complete history or copy its working directory into this repository.

After porting, run `npm.cmd test` and the relevant browser/isolated host checks from `standalone`. Run `npm.cmd run package` to audit the actual VSIX. Existing-account status must continue to use `account/read` without requesting raw credentials. Do not add account pools, credential-file import, rotation or private authentication endpoints.

Rundix 0.2.0 introduces a versioned connection API for separately installed companions. Shared chat/UI changes belong here; companions use the installed base rather than copying those files. See `standalone/docs/connection-api.md`. Earlier standalone forks still require manual porting until they migrate to a companion. Do not merge their private history into this repository.
