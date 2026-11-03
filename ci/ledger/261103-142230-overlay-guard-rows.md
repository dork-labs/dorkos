---
id: 261103-142230
title: 'The design-token gate learns seven rules that hold every overlay to one surface'
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

UI overhaul Phase 2, overlays PR A, put every menu, popover, tooltip, dialog, sheet and drawer on one surface. `scripts/check-design-tokens.ts` holds them there with seven hard rules, OVERLAY-SPEC §12's guard rows 1 to 6 plus one the designer asked for: `modal-surface-border` refuses a border in `dialog`, `alert-dialog`, `sheet` and `drawer` (the dark-only hairline on a floating surface isn't in those files); `menu-separator-fill` refuses a painted separator in the menu primitives; `menu-focus-accent` refuses `focus:bg-dui-accent` and `focus:bg-accent` there (`command.tsx` stays outside the rule until the palette pass); `tooltip-no-delay` refuses `delayDuration={0}` and a zero default anywhere in the two scopes (tests are already exempt); `overlay-header-centered` refuses `text-center` in the dialog, alert and drawer primitives; `tooltip-show-on-touch` keeps `showOnTouch` to `tooltip.tsx` and `button.tsx`, so a disabled button's reason stays readable on a phone and nothing else brings tooltips back to touch; `overlay-literal` refuses `rounded-t-[`, `w-[100px]` and `opacity-70` in the overlay primitives. Each is at zero after the product commit, so none has a baseline entry. Rows 7 to 9 land with PR B.

Same job, same cost (text only, under a second). Revert a rule if it starts flagging a sanctioned use; the patterns are regexes and could miss a class built by template.
