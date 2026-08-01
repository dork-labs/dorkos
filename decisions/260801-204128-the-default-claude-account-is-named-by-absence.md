---
id: 260801-204128
title: The default Claude account is named by the absence of CLAUDE_CONFIG_DIR, not by its path
status: accepted
created: 2026-08-01
spec: claude-code-accounts
superseded-by: null
---

# 260801-204128. The default Claude account is named by the absence of `CLAUDE_CONFIG_DIR`, not by its path

## Status

Accepted. Shipped in #621 (DOR-729).

## Context

Selecting an account only means something if the choice reaches the SDK subprocess, and the choice has
to be **explicit** rather than inherited — an inherited value is the non-determinism the feature exists
to remove, and it is also what makes concurrent account use safe (260801-204129). The obvious spelling
is to pin `CLAUDE_CONFIG_DIR` to the resolved root at every spawn site, unconditionally.

That spelling breaks every default install. Claude Code derives its macOS Keychain entry name as
`Claude Code-credentials[-<8 hex of sha256(configDir)>]`, and it takes the **unsuffixed** branch exactly
when `CLAUDE_CONFIG_DIR` is **unset** — not when it is set to the default path. Verified twice: the
bundled `sdk.mjs` tests `t !== undefined ? !t : !process.env.CLAUDE_CONFIG_DIR`, and on a real machine
`Claude Code-credentials` exists while `Claude Code-credentials-10af4501` — the suffix for `~/.claude` —
does not, whereas `~/.claude2` and `~/.claude3` exist only under their suffixed names. So writing
`CLAUDE_CONFIG_DIR=~/.claude` where nothing was set is not a no-op: it points the CLI at a Keychain
entry that was never created, and sign-in fails.

This whole mechanism is observed behavior of one Claude Code release and macOS-only. It is not a
documented contract.

## Decision

We will treat **absence as a value**. `claudeConfigDirEnv(root)` returns a one-entry fragment spread
into every spawn's `env`, and that entry is `undefined` when absence is the faithful spelling of the
wanted account. Node's `child_process` skips `undefined` when it builds the child environment, so this
both overrides an inherited value and erases it — which is how absence still satisfies "an explicit
choice overrides an inherited `CLAUDE_CONFIG_DIR`". The key is always decided by DorkOS and never
inherited, whichever branch it takes.

Absence is the spelling for `~/.claude` on every route **except one**: when the launching environment
already named `~/.claude` itself. That operator authenticated under that regime, so their _suffixed_
entry is the one that exists, and naming the path is right for them.

And we will depend on the Keychain scheme **nowhere else**. Account validation is structural: a
directory qualifies when it holds a `projects/` subdirectory, which cleanly separates the three real
accounts from `~/.claude-worktrees` and `~/.claudekit`. Authentication failures surface as runtime
errors, which is honest, rather than as a pre-flight guess that breaks on the next release or on Linux.

## Consequences

### Positive

- Default installs keep working. The pin is a no-op exactly where a no-op is correct, and explicit
  everywhere a wrong guess would cost money.
- One function owns the rule, so a new spawn site inherits it by spreading a fragment rather than by
  reasoning about Keychain naming.
- Nothing gates on the credential scheme, so a Claude Code release that renames its entries, or a Linux
  machine that has no Keychain at all, changes only _why_ an auth error happens and never _whether_
  DorkOS lets the attempt through.

### Negative

- The exception looks redundant and reads like dead code. `ambientNamesRoot` produces an explicit pin
  to the value the environment already held, which any reviewer will want to delete. It is load-bearing
  and only a long comment says so.
- **This test was got wrong once, in this very change.** The first implementation read "absence names
  the default" as "the ambient variable is unset **and** the root is the default". Launched from a shell
  exporting `~/.claude2`, selecting `~/.claude` then produced an explicit pin, Claude Code looked up the
  suffixed entry, and sign-in failed — breaking exactly the acceptance criterion the pin exists to
  satisfy. The distinction is between which Keychain _branch_ Claude Code takes and whether the name for
  the _wanted_ account exists; conflating them is what produced the bug, and it will be tempting to
  conflate them again.
- Structural validation admits directories that are not authenticated. A freshly created `projects/`
  under a directory nobody has signed into passes, and the operator learns otherwise from a failed turn.
  That is the accepted price of not guessing.
- The behavior is verified against one Claude Code version on one platform. The dependency is confined
  to this one function, but it is still a dependency on something nobody promised to keep.

## Relationships

- **Makes 260801-204129 safe.** The env lock mutates `process.env.CLAUDE_CONFIG_DIR` process-globally;
  every spawned query is immune only because it spells the variable out through this function. The two
  are load-bearing for each other and must not be separated.
- **Supplies the account** resolved by 260801-204126 (new sessions) and 260801-204127 (resumed ones).
