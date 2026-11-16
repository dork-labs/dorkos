---
id: 261115-211809
title: Prove Codex protects git metadata in temporary workspaces
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.codex-sandbox, wf.codex-binary-macos.codex-binary-macos]
prs: []
ratchet-release: []
field-changes: []
---

DOR-4485 adds real-binary linked-worktree regressions to the registered
Codex native suite. It checks the .git pointer, per-worktree and common metadata,
while requiring successful git reads, ordinary source edits and temporary writes.
The existing app-server and legacy-exec cases retain their secret canaries and
Default, Accept edits and Full controls. No assertion is removed or relaxed.

The original two cases fail on unchanged base under TMPDIR=/tmp because
Accept edits can change git metadata. With the product fix, all four selected
native cases pass under both ambient TMPDIR and TMPDIR=/tmp. Separate mutations omit only metadata write restrictions or only protection
scan bases, retaining the same four-case selection (44 collected, 40 skipped).
The former discriminates non-Full metadata writes; the latter discriminates
secret reads inside linked metadata at Accept edits and Full. Ordinary Git
reads and Full metadata writes remain positive controls.

This records regression coverage for a product policy fix, not a pipeline
performance experiment. No workflow, required check, timeout, retry, shard,
permissions or quality floor changes. Revisit the added case if it is
nondeterministic or no longer catches removal of the protection; preserve an
equivalent real-binary negative and ordinary-write positive control.
