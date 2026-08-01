---
id: 260801-204126
title: A Claude account is a config directory, and choosing one adds it to the set DorkOS reads
status: accepted
created: 2026-08-01
spec: claude-code-accounts
superseded-by: null
---

# 260801-204126. A Claude account is a config directory, and choosing one adds it to the set DorkOS reads

## Status

Accepted. Shipped in #621 (DOR-729).

## Context

A "Claude Code account" is not a DorkOS concept — it is a Claude config directory. That directory holds
the account's `projects/` transcripts and its own sign-in, which is why pointing the SDK at a different
one changes both the history DorkOS can see and the subscription the work bills to. An operator running
one account per paying client therefore runs several of them.

Before this change, which directory DorkOS used was decided entirely by whatever `CLAUDE_CONFIG_DIR`
the launching terminal happened to export, inherited silently, unchangeable from inside the product.
Measured on the operator's machine for one repo: 96 sessions split 50 / 41 / 5 across `~/.claude`,
`~/.claude2` and `~/.claude3`, of which DorkOS showed at most 50 and reported nothing wrong. The
failure shape is the one DOR-682 measured for the search corpus — a short list is indistinguishable
from a complete one.

The naive fix is one config field naming the account to run on. That fix is the trap: it moves new work
to `~/.claude2` while listing still covers only the old root, so the product now under-reports the very
account the operator is working in, still silently.

## Decision

We will model an account as its **path** and store two things under `runtimes.claudeCode`:
`activeAccount: string | null` and `accounts: Array<{ path, label }>`. The path is the identity because
it is literally what `CLAUDE_CONFIG_DIR` takes — nothing to generate, migrate, or keep in step. The
label exists because the operator's real question is _which client_ a session belongs to, and
`~/.claude2` does not answer that while "Acme Corp" does. `activeAccount` is a path and never an index
into `accounts`, so removing an account can never silently repoint the selection at a different client.

Two resolvers read that state, and one of them is derived from the other:

- `resolveActiveClaudeRoot()` → `activeAccount ?? $CLAUDE_CONFIG_DIR ?? ~/.claude`. What a **new**
  session runs and bills on. The configured account sits **in front of** the env var, which is what
  makes the account deterministic instead of a property of the launching shell.
- `resolveClaudeRootSet()` → the deduplicated union of the active root, `$CLAUDE_CONFIG_DIR` when set,
  `~/.claude` unconditionally, and every registered account. What **listing and search** enumerate.

Because the set is built _from_ the active root, selecting an account necessarily adds it to what
DorkOS reads. `~/.claude` stays in unconditionally even when another account is active, because the SDK
may already have written there and dropping it hides history.

Membership in the set is **structural**: a directory qualifies when it holds a `projects/`
subdirectory. DorkOS never globs `~/.claude*` — that guess sweeps up `~/.claudekit` and
`~/.claude-worktrees`, neither of which is an account. Both leaves are `operator-only`: a config
directory carries its own sign-in, so writing `activeAccount` moves the operator's spend onto another
client's subscription, and an agent holding `operator.config_patch` must not be able to do that.

## Consequences

### Positive

- The under-coverage bug cannot come back by half. There is no way to select an account without also
  reading it, because the two answers come from one derivation rather than from two config fields with
  independently drifting semantics.
- DOR-682's message-search corpus and the session list enumerate the identical set from the same
  function, so the two features cannot disagree about what history exists.
- The defaults `{ activeAccount: null, accounts: [] }` are byte-for-byte the previous behavior,
  including honoring an inherited `CLAUDE_CONFIG_DIR`, so nothing changes until a person chooses.
- Neither resolver throws. An unreadable config narrows the answer to the inherited default rather than
  breaking a read that sits on the transcript path.

### Negative

- The root set can legitimately be **empty** — a freshly authenticated account has no `projects/` yet,
  and the structural filter excludes it even when it is the active root. Every caller must treat empty
  as "no sessions" and must not assume the active root is a member. This is a real footgun that only a
  comment and a test protect.
- Registration is manual. Refusing to auto-discover is right, but it means an operator who forgets to
  register `~/.claude3` sees the same short list the feature exists to fix, with nothing to tell them
  so beyond the account they can see is missing.
- Ordering is load-bearing in a way the config shape does not advertise: the roster's order decides
  which account wins if a session id ever appeared under two roots. Ids are root-unique today, so this
  is latent rather than live, and it is asserted in a test rather than enforced by a type.
- `accounts[].path` and `accounts[].label` are declared `operator-only` but **are not enforced**: the
  policy walker stops at arrays, so an agent holding `operator.config_patch` can append to the roster
  even though it cannot change `activeAccount`. That adds a directory to what DorkOS enumerates — an
  information-disclosure surface, not a billing one. The gap is pre-existing and general (the identical
  probe on `connectors.rawMcpServers` behaves the same way) and is filed as DOR-737; it was deliberately
  not special-cased here, because a fix for one path while the general mechanism stays broken becomes
  dead code the day the walker learns arrays.

## Relationships

- **Precondition for 260801-204127** (a session's account is derived from disk): the set this resolves
  is what that lookup probes.
- **Shares a resolver with DOR-682** (message search). The dependency was stated by neither spec until
  this one; it is now a single function rather than a convention.
