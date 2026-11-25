---
id: 261125-005206
title: queue re-entry turns auto-merge back on only for branches of this repository
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.queue-reentry.sweep
prs: []
ratchet-release: []
field-changes: []
---

The re-entry sweep (DOR-5098) now skips a pull request whose head is in a fork, and one whose
origin it can't read. A maintainer turns auto-merge back on for those, as for the first arming.
Branches of this repository are unchanged. Pinned in scripts/test-queue-reentry.sh.

Revert if fork pull requests are ever armed automatically at open as well; then this sweep can
follow the same rule.
