---
name: different-name
description: Skill whose frontmatter name does not match its directory name.
kind: skill
---

# Conflicting Skill

This SKILL.md lives in `skills/analyzer/` but its frontmatter declares
`name: different-name`, which makes the parser reject it.
