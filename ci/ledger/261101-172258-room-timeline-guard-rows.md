---
id: 261101-172258
title: "The design-token gate learns four hard rules for a room timeline's rows"
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: [3388]
ratchet-release: []
field-changes: []
---

UI overhaul Phase 4, rooms PR A, restyled the rows a room draws: notices, reactions, the thread row. `scripts/check-design-tokens.ts` holds them there with four hard rules, as ROOMS-SPEC §11's guard rows ask. Three are scoped to `widgets/room-view`, `features/entry-actions` and `features/conversation/ui/rows`: `room-warning-text` refuses `text-status-warning` on text (the glyph's `text-status-warning-fg` passes); `room-italic` refuses `italic` inside a class string, not in comments; `reaction-pill-border` refuses a border class on a reaction pill in `EntryReactionRow.tsx` (`dui-dark:border` and prose pass). `reaction-ring` refuses `animate-reaction-ring` anywhere. Each is at zero after the product commit, so none has a baseline entry. The baseline only falls: two `stray-focus-ring` entries (MomentRow, NoticeRow) are removed because those files now use `focus-ring-inset`.

Same job, same cost (text only, under a second). Revert a rule if it starts flagging a sanctioned use; the class-string rules are regexes and could miss a class built by template.
