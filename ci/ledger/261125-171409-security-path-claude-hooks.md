---
id: 261125-171409
title: .claude/hooks/ is a Security path
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-gate.security-gate
prs: []
ratchet-release: []
field-changes: []
---

Since Nov 25 a user-level hook on this Mac runs `.claude/hooks/user-level-heavy-guard.sh` from the main checkout for
every Claude Code session, and that script runs other files in `.claude/hooks/` (the guards, `run-node-hook.sh`,
`lib/`). A change there reaches every session on every account, so it gets Security's review like the other paths in
`SECURITY_PATH_PATTERN`. The pattern gains `\.claude/hooks/` in `security-gate.yml`, the reviewed fixture and
`tools/security-approve/Policy.swift`, kept equal by the parity test; Security updates its installed local checker to
match. Per Security (Nov 25).
