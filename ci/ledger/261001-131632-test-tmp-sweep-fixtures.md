---
id: 261001-131632
title: Pin the test temp-folder sweep's keep side in the fixtures job
kind: hygiene
status: active
actor: agent
gates:
  - wf.scripts-test.fixtures
prs: []
ratchet-release: []
field-changes: []
---

On 2026-10-01 the operator's Mac had 45,977 top-level entries in its per-user
temp folder (`$TMPDIR`), growing by about 4,000 a day, and about 60% of the
machine's file-system events came from there. 30,454 of those entries were
`mkdtemp` folders our own vitest suites made and never removed: the
`packages/db` migration tests alone left about 7,700 folders holding about
200,000 files (a copy of the migrations folder per test), and the
marketplace-mcp tool tests about 5,400 empty boundary roots.

Two changes. The biggest leakers now clean up after themselves (the eleven
migration tests remove their copy right after `migrate()`, the two
marketplace-mcp tool suites remove their roots after each test). And
`scripts/sweep-test-tmp.sh` is the machine-wide backstop for every other one:
it removes allowlisted, mkdtemp-shaped entries older than 24 hours that `lsof`
says nothing has open, and refuses any `$TMPDIR` that is not the per-user temp
folder. It rides the existing Docker orphan sweep LaunchAgent (template
updated), which an operator installs; no gate runs the sweep itself.

This entry adds one step to the required `fixtures` job,
`bash scripts/test-sweep-test-tmp.sh`, and the matching link in
`test:scripts` that the shell-suite parity test demands. The sweep deletes on
shared developer machines, so its keep side is pinned with a positive control
for every keep case. Expected on this machine: allowlisted entries older than a
day stay near zero after each run instead of growing past 30,000; nothing in CI
measures that, so it is written here rather than as a hypothesis.

No required check, deadline, shard, retry or coverage rule changes. The step is
hermetic (a fake root the sweep accepts only with an explicit fixture switch
plus a marker file, and a stub `lsof` on PATH) and takes a few seconds. Revert
by removing the step and the `test:scripts` link together.
