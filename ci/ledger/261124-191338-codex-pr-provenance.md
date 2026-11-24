---
id: 261124-191338
title: Record a bare Codex chat in PR provenance
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

DOR-4839. A PR opened from a native Codex chat can now carry its eight-character public chat
reference. The provenance CLI reads `CODEX_THREAD_ID` for Codex. A DorkOS chat ID still takes
precedence, and the existing shared writer shortens the ID for a public PR.

The CLI suite covers harness and chat selection. The opener fixture uses a synthetic thread
to check the PR body and the local command output. Revert if an opener attributes a PR to the
wrong chat or includes the full thread ID.
