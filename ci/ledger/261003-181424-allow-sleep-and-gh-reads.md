---
id: 261003-181424
title: Allow sleep and read-only gh commands in the repo allowlist
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Why: a session started in accept-edits mode may only run shell commands on this
allowlist without asking. Two commands every unattended session needs were missing:
`sleep`, which the operator's own rule tells sessions to use between short check-ins
on their helpers (never quiet more than five minutes), and the read-only `gh` reads
(`pr view`, `pr checks`, `pr list`, `pr diff`, `run list`, `run view`, `issue view`,
`repo view`) that a builder uses to watch its own PR. Without them the session stops
on a permission card that nobody is watching, which is the quiet stall this repo is
trying to remove (DOR-2681, conventions rail 15).

What this does not allow: `gh pr create`, `gh pr merge`, any `gh` write, and anything
that pushes. Opening a PR stays a person's click (or a `vcs.*` capability once
DOR-2096 lands). `sleep` touches nothing.

Revert if a session is seen using `sleep` to outwait a limit instead of checking in,
or if a `gh` read is found to carry a side effect.
