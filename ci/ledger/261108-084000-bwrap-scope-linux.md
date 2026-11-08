---
id: 261108-084000
title: Temporary native Linux backup mount evidence
kind: hygiene
status: proposed
actor: agent
gates: [wf.bwrap-scope-linux.linux-evidence]
prs: []
ratchet-release: []
---

Never-merged held draft for DOR-3949 and DOR-3950. This optional Ubuntu 24.04
job reuses codex-sandbox's distro bubblewrap and scoped AppArmor setup, real
pinned binary and synthetic complete-home fixture. No credentials are used.
Compare the current fixture with the same fixture plus a Claude backup at
Ask, acceptEdits and Full. Record provider requests, transport errors and
generated policy. A separate strace repeat captures the actual bwrap command;
only untraced rows determine the verdict, avoiding tracing as a confounder.

Every A row must reach the fake provider. Each B row must either reach it or
report the exact backup read-only mount failure. Missing or skipped rows fail.
This is evidence collection, not a pipeline performance claim. No required
check, existing test or product policy changes. Close the draft unmerged and
remove the worktree after archiving the run, head and receipts.
