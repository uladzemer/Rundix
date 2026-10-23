# Turn diagnostics

Version 0.4.11 adds one safe outcome record per observed terminal CLI turn. In VS Code, open the existing Rundix Output channel through the extension's Logs action or View → Output → Rundix, then find `[turn diagnostic]`. Headless service logs use `code: "turn_outcome"` and the same fields inside `outcome`, subject to their existing rotation/size bounds.

The record contains only:

- `attempt`: dispatch order in this core instance; not a thread/task ID.
- `account`, `model`: numeric aliases assigned in memory, up to 32 of each; 0 means unknown/overflow. Aliases restart with the core, are not hashes or server identifiers, and cannot be compared across windows/restarts. No lookup table is written. The CLI-visible account identity is used internally; a shared email across workspaces cannot distinguish those workspaces.
- `transition`: comparison against the previous dispatch in the same core. `first` has no baseline; `account_changed` means a different visible account identity; `client_changed` means a different CLI or connection instance with the same visible account; `same_client` means neither changed; `unknown_account` cannot establish account equality. Changes that occur and revert between dispatches are not observed. This is correlation, never proof that switching caused the result.
- `fast`: the selected turn requested a non-default speed tier.
- `status`: completed, failed or interrupted; `category`: a fixed allowlisted CLI error code, `other` or `none`.
- `elapsedSeconds`: elapsed dispatch-to-terminal time, clamped to 0–86400 seconds. It is not time since an account switch.

The model and account keys are captured before dispatch; changing the composer selection during a running turn does not relabel its result. The turn/start RPC response must confirm the turn ID before any outcome is written; a start notification alone cannot bind it. Old-client, wrong-thread, wrong-turn and duplicate completions are ignored. Diagnostic write failures do not change task results. The feature does not replay model input, force token refresh, log messages or credentials, or switch accounts. A rejected/uncertain start without a matching successful RPC response and terminal event has no outcome record; absence is not evidence that the request was never sent. Ordinary CLI retry notifications are not independent failed turns.

## Compare overload with connection changes

Compare successful and failed outcomes for the same numeric account/model aliases in one window/core. A `serverOverloaded` under both `account_changed` and `same_client` weakens the hypothesis that switching is necessary for that failure. Repeated failures only on the first dispatch after a change warrant a separate controlled test; they still do not establish causation. Compare `fast` as well. `unauthorized`, usage-limit and transport codes remain distinct. Unknown error text is never copied into logs or treated as proof of authentication failure. The legacy exact model-capacity phrase is recognized only when there is no stronger typed error.

For a controlled test, use explicit synthetic input and a separate ephemeral CLI profile. Compare two same-model requests without a switch, then the same request after a switch, and return to the original account. Change account only between terminal turns. Reuse one thread to test context transfer; separately use a new empty thread to test whether context is necessary. Real inference consumes account quota and is not performed automatically by diagnostics or the normal test suite.

Green account/limit checks are not model availability tests. A successful short turn verifies that model for that request, not long-term capacity or the precise settings of a different task. A displayed overload also seen in another client is evidence worth comparing, not by itself proof that every local failure has the same cause.
