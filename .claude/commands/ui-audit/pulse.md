---
description: Recurring incremental UI audit — diff-scoped lenses plus one rotating whole-tree lens
argument-hint: ''
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Agent, TodoWrite
category: workflow
---

# UI audit pulse

The recurring, cheap version of `/ui-audit:run`. Read `.claude/skills/auditing-ui/SKILL.md`, the
charter `audits/ui.md`, and `audits/runs/ui/profile.md`, then follow them. Only what is specific
to the pulse is below.

## Contract

1. **Require a baseline.** Read `audits/runs/ui/stamps.json`. A lens missing from it is skipped
   and named in the report; the pulse stops only when the file itself is absent (skill §1). The
   fix is one `full` or scoped `/ui-audit:run`.

2. **Diff-scope per lens.** Give each surface-local lens the changes since **its own**
   `lastAuditedCommit`, never one global stamp. A lens skipped for six weeks sees six weeks.

3. **Run exactly one whole-tree lens**, the one at the rotation cursor, in the charter's Lens
   classes order. Advance the cursor when it completes. This is the only way those lenses ever
   run in a pulse; they cannot be diff-scoped.

4. **Dedup against what is already filed, and age it.** Before emitting, read the open
   `source/audit` items. A finding already filed is **refreshed**, not re-filed. A filed finding
   whose cited code no longer exists is flagged for closure rather than left to rot.

5. **Emit fenced items** per skill §5, or the markdown ledger when the profile says no tracker.

6. **Write stamps** only for lenses that ran, only after their findings are recorded.

7. **Never execute.** The pulse emits and reports; a dropped browser leg is reported, not hidden
   (skill §3). Landing is `/ui-audit:execute` or the workflow path, chosen by a human.
