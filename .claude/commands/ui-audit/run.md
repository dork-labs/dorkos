---
description: Run a UI audit (full, one lens, one surface, or a diff) and emit fenced work items
argument-hint: '[full | lens:<name> | surface:<route> | diff]'
allowed-tools: Read, Write, Edit, Grep, Glob, Task, AskUserQuestion, Bash(git:*), Bash(node:*), Bash(lsof:*)
category: workflow
---

# Run a UI audit

**Scope:** $ARGUMENTS (default `diff`)

Read `.claude/skills/auditing-ui/SKILL.md` and the charter at `audits/ui.md` first. If the
charter is missing, run `/ui-audit:init` instead.

## Contract

1. **Resolve the scope** per the skill's scoping table. `diff` covers surface-local lenses only;
   whole-tree lenses reach a diff run through rotation, never through diff-scoping.

2. **Print a cost estimate before spawning anything, and on `full` get explicit consent.** A full
   run is roughly ten million subagent tokens across a dozen auditors. State the lens count, the
   estimate, and wait for a yes. Scoped runs print the estimate and proceed.

3. **Fan out the auditors**, one per lens, using `assets/auditor-prompt.md`. Parallel where the
   harness spawns agents; sequential otherwise, which is a first-class path and produces the same
   report. Each auditor writes its raw file to `audits/runs/ui/<date>/raw/<lens>.md`.

4. **Run the browser leg** where the scope includes surface-local lenses and an app is runnable,
   under the skill's look-don't-touch rules: your own ports, a standalone Playwright script and
   never a shared browser, no mutating clicks, stop only what you started. If no app is runnable,
   say so in the report and audit code-only.

5. **Synthesize** with `assets/synthesizer-prompt.md`: dedup, spot-verify citations, drop the
   invalid with reasons recorded, batch by collision class. Write
   `audits/runs/ui/<date>/report.md`.

6. **Emit the work items, fenced.** Per the skill's ownership contract, and without improvising:
   one `type/meta` "promotion decision for audit run `<date>`" item, every batch item carrying a
   `blockedBy` edge to it, `source/audit` as provenance only, and **no `agent/*` label, ever**.
   No tracker configured means the ledger at `audits/runs/ui/<date>/backlog.md` instead.

7. **Write the stamps** for the lenses that actually ran (`stamps.json`, per lens, plus the
   rotation cursor). A lens that did not run keeps its old stamp.

8. **Report** the batch list, the coverage gaps including any dropped browser leg, and the
   promotion decision the operator now owes. This command never executes a batch.
