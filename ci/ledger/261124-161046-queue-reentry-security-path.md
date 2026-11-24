---
id: 261124-161046
title: scripts/queue-reentry.sh is a Security path, like queue-repeat-guard
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

queue-reentry (#4273) turns auto-merge back on with the merge-tail app's write token, the same reach as
queue-repeat-guard, which is already on the Security path list. This adds it to SECURITY_PATH_PATTERN,
the reviewed fixture and Policy.swift, with a parity case, so changes to it land in Security's daily
batch. Nothing measurable should move. Revert if the script is retired.
