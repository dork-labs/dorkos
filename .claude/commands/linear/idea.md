---
description: 'Submit an idea to the Linear backlog'
allowed-tools: 'Read, mcp__plugin_linear_linear__save_issue, mcp__plugin_linear_linear__list_issues, mcp__plugin_linear_linear__list_projects'
argument-hint: '<idea description>'
---

# /linear:idea — Quick Idea Capture

Read `.claude/skills/linear-loop/SKILL.md` for issue conventions (title format, description standards).
Read `.claude/skills/linear-loop/config.json` for team configuration.

Create a `type/idea` issue in the DorkOS Linear team. The issue enters Triage state for evaluation on the next `/pm` run.

## Process

1. Take the user's argument as the idea description
2. If no argument provided, ask the user to describe their idea
3. Create the issue in Linear:
   - **Team**: DorkOS (from config.json `team.id`)
   - **Title**: Concise, actionable summary of the idea
   - **Description**: The full idea with any context the user provided
   - **Labels**: `idea` (from type group), `human` (from origin group)
   - **State**: Triage
4. Report the created issue ID and URL

Do NOT evaluate the idea here — that's triage's job. Just capture it cleanly and move on.
