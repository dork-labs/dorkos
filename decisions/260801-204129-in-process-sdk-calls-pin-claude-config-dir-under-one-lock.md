---
id: 260801-204129
title: In-process SDK calls pin CLAUDE_CONFIG_DIR under one lock for writes, and degrade honestly for reads
status: accepted
created: 2026-08-01
spec: claude-code-accounts
superseded-by: null
---

# 260801-204129. In-process SDK calls pin `CLAUDE_CONFIG_DIR` under one lock for writes, and degrade honestly for reads

## Status

Accepted. Shipped in #621 (DOR-729).

## Context

Most Claude Agent SDK work happens in a spawned subprocess, where the account is pinned through
`sdkOptions.env` (260801-204128). Three helpers do not: `renameSession`, `forkSession` and
`getSessionInfo` run **in-process**, so `sdkOptions.env` never reaches them, and their option types
expose only `dir?` / `sessionStore?` — no config dir, no env.

The SDK resolves its config root as
`memoize(() => process.env.CLAUDE_CONFIG_DIR ?? ~/.claude, () => process.env.CLAUDE_CONFIG_DIR)` —
memoized, but keyed on the variable, so mutating the variable does take effect. It is also the only
lever there is. And it is process-global, in a server running concurrent sessions across several
accounts.

So the choice is not between a clean answer and a dirty one. It is between mutating a process-global,
serializing the paths that need it, or accepting that these three helpers act on the wrong account.

## Decision

We will confine every write of `process.env.CLAUDE_CONFIG_DIR` to one module, and wrap only the two
helpers that are rare and explicitly user-initiated. `withClaudeConfigDir(root, fn)` queues callers on a
single async mutex, sets the variable for the duration, and restores the previous value afterwards —
**including restoring its absence by deleting the key**, because an unset variable and an empty one are
different answers to the SDK and to Claude Code's Keychain naming. Rename and fork run under it; a
rejection passes straight through and never poisons the queue for later callers.

The module also exposes `ambientClaudeConfigDir()`, which reports the variable as it is _outside_ any
held critical section, and DorkOS's own resolvers read through it rather than the variable. Without this
a held rename lock could contaminate the root resolved for a brand-new session: `resolveActiveClaudeRoot()`
falls back to the env var when no account is chosen, so an explicit `sdkOptions.env` entry protects the
**transmission** of the value but not its **derivation**. This module is therefore the single production
reader as well as the single writer.

`getSessionInfo` — the SDK-persisted custom title — is deliberately **not** wrapped. It sits on the
session-listing path, and serializing listing behind a process-global mutation trades a cosmetic gain
for a systemic risk. Instead it is called only when the session's account is the active root; sessions
on other accounts show their first-message derivation.

## Consequences

### Positive

- Renaming or forking a session on a non-active account works, correctly, without a server restart and
  without the operator switching accounts first.
- One module to audit. A reviewer asking "who mutates the environment?" gets a single file with the
  invariant, the restore-absence rule, and the reason written at the top.
- The hot path is untouched. Session listing never queues, never mutates a global, and never waits on a
  rename.
- The alternative to gating title reads was reverse-engineering the SDK's title sidecar, which would
  have repeated exactly the undocumented-implementation-detail dependency 260801-204128 refuses.

### Negative

- **A custom title set on account B may not display while account A is active.** The session shows its
  derived title instead. This is a real, bounded, user-visible degradation, chosen over serializing
  every listing. The rename stays enabled because it genuinely persists, and the UI says plainly where
  the new name will appear — left unhandled it reads as "rename did nothing".
- For the duration of a rename or a fork, any **other** subprocess this server spawns that inherits
  `process.env` verbatim sees the pinned account. Every SDK query is immune because it spells the
  variable out explicitly, which is a property of the call sites rather than of the lock — the two
  mechanisms are load-bearing for each other, and separating them reintroduces the bug silently.
- Renames and forks across all accounts serialize against each other globally. Acceptable only because
  both are rare and user-initiated; it would not be if either moved onto a hot path.
- `ambientClaudeConfigDir()` means there are now two answers to "what is `CLAUDE_CONFIG_DIR`", and which
  one a reader wants depends on whether they are inside the critical section. Code inside it wants the
  mutated value; every decision about which account to use wants the ambient one. Nothing but review
  enforces that.

## Relationships

- **Paired with 260801-204128**: explicit spawn-time pinning is what makes this lock survivable, and
  this lock's ambient accessor is what keeps that pin's derivation clean. The refinement was found
  during review of this change, after the first version of the safety argument proved incomplete.
- **Takes its root from 260801-204127**: the wrapped helper is handed the session's own account, never
  one it resolves for itself.
