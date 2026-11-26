---
id: 261126-040759
title: The code that keeps agents off protected files is a Security path
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.security-gate.security-gate
prs: []
ratchet-release: []
field-changes: []
---

The pieces that decide what an agent's file tools and shell may reach, and when a turn counts as having read words
from outside, were not in `SECURITY_PATH_PATTERN`: the protected-files list (`services/core/protected-paths/`), the
untrusted-text helpers, Claude Code's shell guard, secret-file denies, folder settings and folder secrets, Codex's
sandbox profile (`runtimes/codex/policy/`), the shared shell policy and command readers (`runtimes/shared/policy/`,
`runtimes/shared/tools/`), OpenCode's protected-file check, and the shared git hardening and folder grants. A change
there could merge without Security's review. The pattern gains them in `security-gate.yml`, the reviewed fixture and
`tools/security-approve/Policy.swift`, kept equal by the parity test, with six path rows; Security updates its
installed local checker to match. Found while checking a test-sweep move (DOR-4931). Revert an entry only if its
folder stops deciding what an agent may reach.
