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
   - **Evidence** — proof scaled to the work (SKILL.md "Evidence on Close"): test command + pass summary for server/logic work; screenshot or annotated GIF for UI work; video only for temporal behavior. Attach or paste it on the issue.
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

6. **Read Completion Routing** (from the issue description):
   Check the issue description for an `## On Completion` section. If present, use it as the primary signal for what to recommend next. This is the most specific guidance — it was defined when the issue was created and reflects the intended next step.

   If the `## On Completion` section is missing, fall back to the Phase Transitions table below.

7. **Project Pulse Check** (Loop Continuity — see SKILL.md "Loop Continuity" section):
   After closing the issue, assess the project state to recommend the next Loop phase:
   - Query remaining issues in the same project (skip if the issue has no project)
   - Group by type (`type/*` labels) and status
   - Apply the Phase Transitions table from SKILL.md:
     - **All research Done, no hypothesis/spec?** → Recommend `/ideate` (complex) or creating `type/task` sub-issues (simple). Use the Sizing Criteria from SKILL.md.
     - **All tasks under a hypothesis Done?** → Recommend `/linear:done` on the parent hypothesis.
     - **All monitors cleared?** → Recommend moving project to Completed.
     - **Zero remaining active issues?** → Check `specs/manifest.json` for active specs linked to this project (per Spec-Linear Bridge). If active spec exists, do NOT recommend closing. If no spec, recommend moving to Completed.
   - Present the recommendation clearly: what the project state is, what the next action is, and offer to execute it.
   - If no transition is detected (other work still in progress), just report the project status briefly.

8. **Clean up the workspace** (if applicable):
   If the work ran in a dedicated git worktree (the spec's `04-implementation.md` records it, or `git rev-parse --git-dir --git-common-dir` prints two different paths) and its branch is merged, offer `/worktree:remove <branch> --delete-branch`. If the session is currently inside that worktree, leave it first (ExitWorktree or return to the main checkout) before removing.

9. **Report** what was done, any follow-up issues created, and the project pulse check recommendation.
