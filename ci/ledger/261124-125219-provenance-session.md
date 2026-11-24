---
id: 261124-125219
title: open-pr.sh records the session id Claude Code actually sets in the provenance line
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

open-pr.sh read CLAUDE_SESSION_ID for the provenance line's sessionId, but Claude Code sets
CLAUDE_CODE_SESSION_ID, so PRs carried only the shared account (21 of 25 open PRs on Nov 24 had no
sessionId). It now reads CLAUDE_CODE_SESSION_ID first and falls back to CLAUDE_SESSION_ID. v1 line
only, no new keys (DOR-5047 defines v2). Nothing measurable in CI should move; the check is that
PRs opened through the script after merge carry a sessionId.

Revert if a provenance line ever carries more than the first 8 characters of the id.
