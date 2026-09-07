---
description: Run a UI audit (full, one lens, one surface, or a diff) and emit fenced work items
argument-hint: 'full | lens:<key> | surface:<route> | diff'
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Agent, AskUserQuestion, TodoWrite
category: workflow
---

# Run a UI audit

**Scope:** $ARGUMENTS

Read `.claude/skills/auditing-ui/SKILL.md` and the charter `audits/ui.md`, then follow them. The
skill owns the procedure; this command adds only what is specific to running one audit.

## Contract

1. **A scope is required.** There is no default. If `$ARGUMENTS` is empty, ask. Lens keys come
   from the charter's lens list.

2. **Read `audits/runs/ui/profile.md` first** (skill §1). If the charter is missing, run
   `/ui-audit:init` instead of guessing.

3. **The cost gate is this command's own responsibility.** Print the lens count and a token
   estimate before spawning anything, using the per-lens budget in skill §2. On `full`, **wait
   for explicit consent** — a full run is roughly ten million subagent tokens, and the operator
   should agree to that knowingly. Scoped runs print the estimate and proceed.

4. **Refuse a `diff` with no baseline.** `diff` requires a stamp per lens (skill §1, bootstrap
   rule). Missing stamps stop the run and name the fix; never silently widen to the whole tree,
   which is the cost gate above being bypassed by accident.

5. **Audit, then synthesize**, per skill §§3-4. Raw findings to
   `audits/runs/ui/<date>/raw/<key>.md`, report to `audits/runs/ui/<date>/report.md`, ISO date.

6. **Emit the work items fenced**, exactly as skill §5 specifies, including its "How to actually
   write it" mechanics. Do not improvise a variant of the fence.

7. **Write stamps** for the lenses that ran, and advance the rotation cursor if a whole-tree lens
   ran. Lenses that did not run keep their entries.

8. **Report** the batch list, every coverage gap including a dropped browser leg, and the
   promotion decision the operator now owes. This command never executes a batch.
