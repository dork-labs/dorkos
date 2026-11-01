---
id: 261031-131900
title: 'The design-token gate learns three hard rules for counts and badges'
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: [3337]
ratchet-release: []
field-changes: []
---

UI overhaul Phase 2 (badge, count and chip, PR A) made `CountPill` the one numbered pill and `Badge` the one label. `scripts/check-design-tokens.ts` keeps it that way with three hard rules: no local count caps (`DISPLAY_CAP`, `MAX_COUNT`, a second `COUNT_PILL_CAP`) outside `count-pill.tsx`; no `tabular-nums` and `rounded-full` on one line outside `count-pill.tsx`, `badge.tsx` and `TouchChip`'s string; and `animate-count-flip` only in `ThreadReplyRow`. Each was at zero when it landed, so no baseline entry. Rules gain an optional `except` pattern for the allowlists, and the baseline was lowered where counts fell.

Same job, same cost (text only, under a second). Revert a rule if it starts flagging a sanctioned use the allowlist can't name.
