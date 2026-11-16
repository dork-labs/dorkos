---
id: 261115-211809
title: Prove Codex protects git metadata in temporary workspaces
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.codex-sandbox, wf.codex-binary-macos.codex-binary-macos]
prs: [3836]
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

PR #3836's first Linux run passed 47 native cases and failed the two new
worktree rows. The Full row planted Claude sign-in backups both in shared
setup and in its local setup, triggering the existing DOR-3965 mount refusal
before its Git controls ran. Its setup now uses the existing Full-only backup
precondition; the dedicated backup-refusal rows remain unchanged. The Git
status positive assertion now includes its scripted response in a failure,
so the separate Accept edits failure can be diagnosed without weakening it.
Linux proof remains outstanding until the actual native job passes.

QA's sealed Ubuntu reproduction found the Accept edits cause: an exact metadata
deny below an already denied ancestor is mounted before its writable root, so
Bubblewrap fails before the scripted command runs. Linux now refuses this
unsupported combination before tools can run, rather than dropping the denial.
The ordinary-worktree rows retain their successful Git and ordinary-write
controls; separate Linux rows assert refusal before process acquisition for a
protected-ancestor writable grant. Seatbelt's working overlap control stays in
the macOS rows. Direct rendering tests cover Linux refusal and macOS denial.
These modeled and macOS results do not substitute for the actual Linux job.
