---
description: Land audit batches on the audit path — fence verified first, items stay blocked until merge
argument-hint: '<batch-range, e.g. 1-4 or 7>'
allowed-tools: Read, Write, Edit, Grep, Glob, Task, AskUserQuestion, Bash
category: workflow
---

# Execute UI audit batches

**Batches:** $ARGUMENTS

Read `.claude/skills/auditing-ui/SKILL.md` (especially the ownership contract) and
`.claude/skills/orchestrating-parallel-work/SKILL.md` (the landing playbook) first.

## Contract

1. **Verify the fence before touching anything.** For every batch item in range: its `blockedBy`
   edge to the run's `type/meta` promotion-decision item is still present, and the item carries no
   `agent/*` label. If either check fails, the item has already been promoted to the workflow
   path and is no longer yours. Stop and report it rather than working it.

2. **Confirm the fork.** These batches are being worked on the **audit path**, which means the
   fence stays up against the workflow engine for the whole of it. If the operator meant the
   workflow path, the right move is removing the edge and letting the normal lifecycle take over,
   not running this command.

3. **Claim in the plugin namespace.** In-progress visibility uses `audit/claimed`. Never write
   `agent/*`: those are the workflow engine's claim labels, and borrowing one makes its own loops
   treat the item as orphaned work to re-adopt, inverting the fence.

4. **Land the work** by the playbook in `orchestrating-parallel-work`, adapted to the repo
   profile captured by `/ui-audit:init`: one worktree per batch, batches grouped so parallel
   branches touch disjoint files, an adversarial review on the branch **before** the PR opens
   (`assets/review-brief.md`, pointing at `REVIEW.md` and its failure-mode library), then
   finalize. Every finding in the batch is walked item by item; simplify-first is reviewable.

5. **Items stay blocked until they close.** Do not resolve the `blockedBy` edge to unblock
   yourself; the item transitions to done when its PR merges, still fenced, and the edge dies
   with it.

6. **Close out the run.** When every batch in the run is promoted or closed, close the `type/meta`
   promotion-decision item. It has an end of life on purpose: left open it becomes the stale
   ledger a backlog groom sweeps at.
