---
name: different-name
description: Skill whose frontmatter name does not match its directory name.
kind: skill
---

# Conflicting Skill

This SKILL.md lives in `skills/analyzer/` but its frontmatter declares
`name: different-name`. Claude Code tolerates this (skills are keyed by
directory name), so the validator surfaces it as a SKILL_NAME_MISMATCH
warning rather than a blocking error (DOR-263).
