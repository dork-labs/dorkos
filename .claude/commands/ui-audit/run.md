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

2. **Read `audits/runs/ui/profile.md` first** (skill §1). If the **profile** is missing, say so,
   name `/ui-audit:init`, and proceed on skill §1's conservative fallback. If the **charter** is
   missing, run `/ui-audit:init` instead of guessing: there is no audit without it.

3. **The cost gate is this command's own responsibility.** Print the lens count and a token
   estimate before spawning anything, using the per-lens budget in skill §2. On `full`, **wait
   for explicit consent** — a full run is roughly ten million subagent tokens, and the operator
   should agree to that knowingly. A scoped run has no consent moment, so its estimate goes in
   the report header beside the mode, the date, and the commit, where it outlives the session.

4. **Refuse a `diff` with no baseline.** `diff` requires a stamp per lens (skill §1, bootstrap
   rule). Missing stamps stop the run and name the fix; never silently widen to the whole tree,
   which is the cost gate above being bypassed by accident.

5. **Create `audits/runs/ui/<date>/raw/` before spawning** (ISO date). Auditors write into it;
   they do not create it. Then audit and synthesize per skill §§3-4 — raw findings to
   `raw/<key>.md`, report to `report.md`, and fill each auditor's browser-leg block by the
   predicate in skill §3, not by feel.

6. **Emit the work items fenced**, exactly as skill §5 specifies, including its "How to actually
   write it" mechanics. Do not improvise a variant of the fence.

7. **Write stamps** for the lenses that ran, and advance the rotation cursor if a whole-tree lens
   ran. Lenses that did not run keep their entries.

8. **Report** the batch list, every coverage gap including a dropped browser leg and the lenses
   that did not run, and the promotion decision the operator now owes. **Leave the run log
   uncommitted** and name its paths: `audits/` has to be tracked before a batch worktree can see
   it, and committing it is the operator's call, not the audit's. This command never executes a
   batch.
