---
id: 261105-103049
title: Repair preservation and root-owned native fixtures without relaxing protections
kind: hygiene
status: proposed
actor: agent
gates: [wf.test.codex-sandbox]
prs: [3480]
ratchet-release: []
field-changes: []
---

Run41967701245 exposed two fixture mismatches with the approved preserve
contract: descendant lstat returns ENOTDIR behind an unchanged recorded crash
file, and sudo cannot elevate from unprivileged strace. Require ENOTDIR only
under an exact snapshot-preserved crash target; other targets still require
ENOENT. Keep all controls and the Full-mode final host-file assertion unchanged.
Prepare the root-owned fixture outside strace, require root ownership in the
native row, and restore/remove the exact fixture after the owned trace group
is stopped. Setup/cleanup failures remain failures; driver tests cover cleanup.
No timeouts, retries, gates, permissions or test skips change. This is hygiene,
not evidence that the native rows pass. Revert if revised fixtures hide a host
mutation or cannot prove the same root-owned layout. Linux verification pending.
