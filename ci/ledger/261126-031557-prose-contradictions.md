---
id: 261126-031557
title: CI docs stop counting pre-push commands and hooks by hand (DOR-4941)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

`contributing/ci.md` said pre-push "does exactly three things" while lefthook runs more, and counted hooks by hand. Hand counts drift each time a command is added. The guide now points at `lefthook.yml` and `.claude/settings.json` instead of counting, and drops the retired per-edit typecheck hook. Docs only: no gate, command or workflow changes, so nothing measurable should move.
