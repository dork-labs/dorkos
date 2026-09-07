---
description: Land audit batches on the audit path — fence verified first, items stay blocked until merge
argument-hint: '<batch-range, e.g. 1-4 or 7>'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Agent, AskUserQuestion, TodoWrite
category: workflow
---

# Execute UI audit batches

**Batches:** $ARGUMENTS

Read `.claude/skills/auditing-ui/SKILL.md` (the ownership contract is §5, landing is §7) and
`audits/runs/ui/profile.md`. This command adds only the fence checks; the skill owns everything
else.

## Contract

1. **Verify the fence before touching anything.** For every batch item in range: its `blockedBy`
   edge to the run's `type/meta` promotion-decision item is still open, and the item carries no
   `agent/*` label. Read the labels as leaf names (skill §5). If either check fails, the item was
   already promoted to the workflow path and is no longer yours: stop and report it.

2. **Confirm the fork is the audit path.** Working here means the fence stays up against the
   workflow engine for the whole batch. If the operator meant the workflow path, the move is
   removing the edge and letting the normal lifecycle take over, not running this command.

3. **Claim in the plugin namespace only** — `audit/claimed`, never `agent/*`, and never with a
   label write computed from a stale read (skill §5).

4. **Land the work** by skill §7's playbook, adapted to the profile: one worktree per batch,
   batches grouped so parallel branches touch disjoint files, an adversarial review on the branch
   **before** the PR opens (`assets/review-brief.md`), then finalize. Walk each batch's findings
   item by item; simplify-first is reviewable.

5. **Items stay blocked until they close.** Never resolve the `blockedBy` edge to unblock
   yourself. The item goes to done when its PR merges, still fenced, and the edge dies with it.

6. **Close out the run.** When every batch in the run is promoted or closed, close the `type/meta`
   promotion-decision item. It has an end of life on purpose: left open, it becomes the stale
   ledger a backlog groom sweeps at.
