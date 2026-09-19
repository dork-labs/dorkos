---
id: 260919-231511
title: lint-changed only lints files inside the repo
kind: hygiene
status: active
actor: agent
gates: [claude.PostToolUse.lint-changed, wf.scripts-test.fixtures]
prs: []
ratchet-release: []
field-changes: []
---

`lint-changed.sh` decides whether it is "in the project" from the working
directory, then lints whatever path the write tool reported. A session started
in this repo that writes a helper into its scratchpad therefore ran eslint on a
file with no eslint config anywhere above it: eslint exits non-zero with
"couldn't find an eslint.config.\* file", the hook exits 2, and the write is
BLOCKED with a message that reads like a lint error in code the agent just
wrote. Measured on this machine on 2026-09-19, twice in one session.

The hook now skips any path outside the repo root. A new fixture suite
(`scripts/test-lint-changed-hook.sh`, wired into `test:scripts` and the
scripts-test workflow) pins both halves: out-of-repo files are skipped even
when they would fail lint, and an in-repo file with a real lint error is still
blocked. The suite fails 2 of 5 cases against the previous hook.

Hygiene, not an experiment: no gate timing or catch rate should move. Revert if
a real in-repo lint error ever reaches a commit that this hook should have
blocked.
