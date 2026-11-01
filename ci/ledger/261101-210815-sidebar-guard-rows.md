---
id: 261101-210815
title: "The design-token gate learns four rules for the sidebar's tint ramp, text contrast, icon sizes and orange ink"
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

UI overhaul Phase 4, sidebar PR C, put the sidebar's header, footer and phone Home on one edge and made every control the real Button. `scripts/check-design-tokens.ts` holds the panel there with four rules, as SIDEBAR-SPEC §9's guard rows ask, all scoped to `features/dashboard-sidebar/`: `sidebar-faded-text` (hard) refuses `text-sidebar-foreground/10`–`/50`, which measured 3.25:1 on the light panel; `sidebar-off-ramp-fill` (hard) refuses `bg-accent` and `bg-muted`, which flip between themes, in favour of the `--sidebar-accent` ramp; `sidebar-icon-literal` (ratchet) refuses `size-3`, `size-3.5` and `size-4` in favour of the shared icon-size tokens; `sidebar-brand-fill` (hard) refuses `bg-brand` and `text-brand`, so orange stays ink (`*-brand-text`). Each is at zero after the product commit, so none has a baseline entry. The baseline only falls: six `stray-focus-ring` entries (CommunityContextSwitcher, YouRows, NewMenu, SidebarHeaderBlock, SidebarSearchPill, PromoCard) are removed because those controls now use the shared ring.

Same job, same cost (text only, under a second). Revert a rule if it starts flagging a sanctioned use; the patterns are regexes and could miss a class built by template.
