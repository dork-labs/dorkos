---
id: 261108-143700
title: Temporary release 0.134 native backup verification
kind: hygiene
status: proposed
actor: agent
gates: [wf.rel0134-bwrap-scope.linux-evidence]
prs: []
ratchet-release: []
---

Never-merged held draft for DOR-3949 and DOR-3950. This optional Ubuntu 24.04
job reuses codex-sandbox's distro bubblewrap and scoped AppArmor setup, real
pinned binary and synthetic complete-home fixture. No credentials are used.
Fixture A omits Claude backups; all three modes must reach the loopback fake provider. Fixture B plants ~/.claude/backups/.claude.json.backup.*. Ask first and Workspace write must reach the provider; Full access must refuse with codex_sandbox_unavailable and no retry-your-message text (known DOR-3965). Six rows must execute; no tracing or account. No required gate or product policy changes. Close held draft unmerged.
