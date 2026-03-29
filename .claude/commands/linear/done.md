---
description: 'Report completion on a Linear issue and close the loop'
allowed-tools: 'Read, Grep, Glob, mcp__plugin_linear_linear__save_issue, mcp__plugin_linear_linear__get_issue, mcp__plugin_linear_linear__save_comment, mcp__plugin_linear_linear__list_issues'
argument-hint: '[issue-id]'
---

# /linear:done — Close the Loop

Read `.claude/skills/linear-loop/SKILL.md` for conventions.
Read `.claude/skills/linear-loop/config.json` for team configuration.

Report completion on a Linear issue. This is an intentional act — "I'm satisfied, close the loop."

## Process

1. **Identify the issue**: Use the argument (e.g., `DOR-123`), or if no argument, check:
   - Is there a spec in progress with a `linear-issue:` frontmatter field?
   - Was an issue recently claimed in this session?
   - Ask the user which issue to close.

2. **Build the completion comment**:
   - What was done (brief summary)
   - Files changed (if applicable)
   - Spec directory link (if routed through spec workflow)
   - Any follow-up issues needed
   - For hypotheses: whether validation criteria were met

3. **Add the comment** to the Linear issue using `save_comment`.

4. **Update the issue**:
   - Move to "Done" state
   - Remove `agent/claimed` label if present
   - Add `agent/completed` label

5. **Create follow-up issues** (if applicable):
   - For `type/hypothesis` issues: create a `type/monitor` issue with the validation criteria from the hypothesis description. Label it `from-agent` origin.
   - If the completed issue was blocking other issues, note that they're now unblocked.

6. **Report** what was done and any follow-up issues created.
