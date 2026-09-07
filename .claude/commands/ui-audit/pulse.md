---
description: Recurring incremental UI audit — diff-scoped lenses plus one rotating whole-tree lens
argument-hint: ''
allowed-tools: Read, Write, Edit, Grep, Glob, Task, Bash(git:*), Bash(node:*), Bash(lsof:*)
category: workflow
---

# UI audit pulse

The recurring, cheap version of `/ui-audit:run`. Read
`.claude/skills/auditing-ui/SKILL.md` and `audits/ui.md` first.

## Contract

1. **Diff-scope the surface-local lenses, per lens.** Read `audits/runs/ui/*/stamps.json` for
   each lens's own last-audited commit, and give each lens the changes since **its** stamp, not
   since one global stamp. A lens skipped for six weeks still sees six weeks of change.

2. **Run exactly one whole-tree lens, from the rotation.** Duplication, placement, API
   consistency, componentization, and playground coverage cannot be diff-scoped; they are reached
   only here, one per pulse, cycling through the list. Advance the rotation cursor when it
   completes.

3. **Degrade the browser leg explicitly.** If no app is runnable (no free port, no build, a dead
   dev server), say so in the report and audit code-only. Never let the browser leg silently
   vanish; a reader assuming it ran is worse than a stated gap.

4. **Dedup against what is already filed, and age it.** Before emitting anything, read the open
   `source/audit` items. A finding already filed is **refreshed**, not re-filed. A filed finding
   whose cited code no longer exists is flagged for closure rather than left to rot.

5. **Emit fenced items** exactly as `/ui-audit:run` does: one per-run `type/meta`
   promotion-decision item, `blockedBy` edges from every batch item, `source/audit` as provenance
   only, no `agent/*` labels. Or the markdown ledger when no tracker is configured.

6. **Write the stamps** only for lenses that ran, only after their findings are recorded.

7. **Never execute.** The pulse emits and reports. Landing is `/ui-audit:execute` or the workflow
   path, chosen by a human.
