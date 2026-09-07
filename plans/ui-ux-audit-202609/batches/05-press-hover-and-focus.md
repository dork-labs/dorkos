[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 5 — Press, hover and focus in the shared primitives

**Priority P1 · 10 findings · 9S · 1M**
**Scope:** one PR over `shared/ui` plus the mobile tab bar. Nine of ten are single class-string edits; each cascades to every consumer. Fixing `Button` first removes the reason the other press implementations exist.

### 5.1 — The `Button` primitive has no press feedback at all

**P1 · S · lenses 9 + 10**
`apps/client/src/layers/shared/ui/button.tsx:8`

**Evidence.** Verified in source: the `buttonVariants` base string is `"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 …"` — no `active:` anywhere, across all 7 variants and 8 sizes, and `Button` never uses `whileTap` either. `design-system.md:204` states the rule as a catalog entry, not an opt-in: "**Button press:** Scale to 0.97 on active, spring back." At least fifteen hand-rolled controls implement it themselves — `sidebar.tsx:490` (0.97), `sidebar-row.tsx:555` (0.98), `SessionRowCompact.tsx:95` (0.98), `TeamMemberCard.tsx:240` (0.99), `ProfileRow.tsx:173` (0.99), `EntryActionMenu.tsx:72,90` (0.95) — which is exactly how the nine-value ladder in 5.7 came to exist. Every ordinary dialog Save, toolbar action and form submit gives no tactile answer while a sidebar row two clicks away does.

**Recommendation.** Put the press in the primitive: `motion-safe:active:scale-[0.97] motion-safe:active:duration-100` on the base string. Narrow `transition-all` to `transition-[color,background-color,border-color,box-shadow,transform]` in the same edit (see 18.7 — `transition-all` here also animates the `md:` height change, so dragging a window across 768px animates every button's height). Then delete the hand-rolled duplicates that only exist because the primitive was silent.

### 5.2 — The phone's only navigation answers a tap with nothing

**P1 · S · lens 10**
`apps/client/src/layers/widgets/mobile-tabs/ui/MobileTabBar.tsx:89-90`

**Evidence.** Verified in source: each of the four destination buttons carries `'focus-ring relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors duration-150'`. No `active:` state, no scale, no tint step. The only change on selection is weight and colour, which lands _after_ the route resolves; `MobileTabsLayout` swaps panels with `visibility: hidden`, so the panel change is instant too. On touch there is no hover to stand in for the missing press. Below 768px this bar is the entire navigation — it replaced the drawer — and the phone surface is launch-critical.

**Recommendation.** Add `motion-safe:transition-transform motion-safe:active:scale-[0.96]` (0.96 rather than 0.97 because the target is a large full-height column, and the identity grammar scales press by target size). Optionally pair with the `active:bg-sidebar-accent` tint the desktop row already uses, so feedback survives `prefers-reduced-motion`, which drops the scale.

### 5.3 — `CollapsibleCard` — five consumers — has no hover state and no focus ring

**P1 · S · lens 9**
`apps/client/src/layers/features/chat/ui/primitives/CollapsibleCard.tsx:50-67`

**Evidence.** Verified in source. This is the one component behind `ToolCallCard`, `ThinkingBlock`, `SubagentBlock`, `CollapsibleRun` and `MemoryRecallBlock`. Its wrapper is `'bg-muted/40 mt-px rounded-md border-l-2 text-sm transition-all duration-200 first:mt-1'` with variant border tints — the only hover in the file is `dimmed && !expanded && 'opacity-50 hover:opacity-100'`, which fires only on already-dimmed completed cards and does nothing for a running or expanded one. `design-system.md`'s "Tool Call Cards" section specifies "**Hover:** border darkens slightly, subtle shadow appears." The header `<button>` that actually toggles the card is `'flex w-full items-center gap-2 px-3 py-1'` — no `hover:bg-*` and **no `focus-visible:` class anywhere in the file**, so a control rendered dozens of times in every transcript falls back to the browser's unstyled outline.

**Recommendation.** Add a hover treatment to the wrapper (`hover:border-l-muted-foreground/50 hover:shadow-soft transition-shadow`, or reuse `card-interactive` once 5.6 lands) and the shared `focus-ring` utility to the header button. One file, five consumers.

### 5.4 — `Collapsible` animates nothing; 55 call sites snap open with a hard layout jump

**P2 · S · lens 10**
`apps/client/src/layers/shared/ui/collapsible.tsx` (`CollapsibleContent`); 17 production consumers, 55 uses, including `settings/ui/tools/ToolGroupRow.tsx`, `settings/ui/runtimes/RuntimeCardView.tsx`, `connections/ui/AccountsRegion.tsx`, `onboarding/ui/SystemRequirementsStep.tsx`, `shared/ui/field-card.tsx`

**Evidence.** Verified in source: `CollapsibleContent` is a bare pass-through with `data-slot` and no className at all. Radix exposes `--radix-collapsible-content-height` and `data-[state=open|closed]` precisely so a consumer can animate it; nothing does. Every collapsible in Settings, Connections, onboarding and agent creation teleports its content in and shoves everything below it down in one frame. `contributing/animations.md:14` points readers at "Accordion animations — CSS keyframes in `index.css`"; **there are no accordion keyframes in `index.css`** — the documented pattern is a dangling reference. The chat layer honours the 300ms expand/collapse timing (`ToolCallCard`, `CollapsibleCard`, `QueuePanel`); the settings layer does not, purely because the shared primitive is empty.

**Recommendation.** Add two keyframes to `index.css` (`collapsible-down`: `height: 0` → `var(--radix-collapsible-content-height)`; `collapsible-up`: the reverse) and put `overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down` on `CollapsibleContent` at 200ms `cubic-bezier(0, 0, 0.2, 1)`. The global reduced-motion reset collapses it to 0.01ms for free. Fix the dangling doc reference at `animations.md:14`.

### 5.5 — Activity rows look and feel clickable when two-thirds have no action, and the hover tint is invisible anyway

**P2 · S · lens 9**
`apps/client/src/layers/features/activity-feed-page/ui/ActivityRow.tsx:76-92`; consumed by `layers/widgets/pulse/ui/PulseActivitySection.tsx:56-58` and the full `/activity` feed; `apps/client/src/layers/shared/ui/table.tsx:44-55`

**Evidence.** Verified in source: every `TableRow` gets `tabIndex={0}` and `focus-visible:ring-ring focus-visible:ring-2` unconditionally, and inherits `TableRow`'s `hover:bg-muted/50` — but the `onKeyDown` only navigates `if (e.key === 'Enter' && item.linkPath)`. On Home's Pulse panel, only one of three rows has a `linkPath`; hovering the other two highlights them identically, Tab stops on them, and Enter does nothing. A hover highlight and a keyboard tab stop are both promises of interactivity.

**Compounding, same component:** even the actionable row's hover is nearly invisible in dark mode. Measured live: `--muted` resolves to `0 0% 9%`, the Pulse panel's ambient background is `rgb(10,10,10)` (~4% lightness), so `bg-muted/50` blends to ~6.5% against a 4% backdrop — a 2.5-point delta, confirmed identical by pixel-diffing before/after-hover crops. The sidebar solves the same problem with `bg-sidebar-accent/70` (`--sidebar-accent` is `0 0% 16%`, ~12% blended) and is obviously visible.

**Recommendation.** Gate `tabIndex`, hover styling and the keydown handler on `item.linkPath` — a non-actionable row should render as plain text. Separately, `--muted` is the wrong token for a hover cue on this theme's dark surfaces: raise `TableRow`'s hover to the sidebar's treatment, or add a token dedicated to "visible hover on a dark surface".

### 5.6 — `card-interactive` gives a hover-only lift with no focus-visible twin, over `transition: all`

**P2 · S · lens 10**
`apps/client/src/index.css:548-554`; consumers `features/marketplace/ui/PackageCard.tsx:110`, `features/agent-creation/ui/GalleryCard.tsx:57`, `features/runtime-connect/ui/OpenCodeProviderPicker.tsx:174`, `features/connections/ui/ServiceGrid.tsx:93`

**Evidence.** Verified in source — the utility is `transition: all 150ms ease-out` plus a `&:hover` block setting `box-shadow` and `border-color`, with no `:focus-visible` branch. `PackageCard` adds a focus _ring_ separately, but the informational half — the elevation and border step that says "this card is under your pointer" — never fires for a keyboard user. `design-system.md:607` makes this a rule: "If an area has a hover state, it has a focus-visible twin conveying the same information — a keyboard user must never learn less than a mouse user." Separately, `transition: all` on a card animates border-width, padding and any layout property a consumer adds.

**Recommendation.** Add `&:focus-visible, &:has(:focus-visible)` carrying the same two declarations, and narrow the transition to `box-shadow, border-color, transform`. Add the missing `-1px` lift while there, so the utility actually implements the Surface tier the grammar defines.

### 5.7 — Press feedback has no ladder — nine scale values across two mechanisms

**P2 · M · lens 10**
CSS `active:scale-*`: `sidebar.tsx:490` (0.97), `sidebar-row.tsx:555` (0.98) and `:681,700` (0.94), `TodayZone.tsx:182` (0.98), `SessionRowCompact.tsx:95` (0.98), `ProfileRow.tsx:173` (0.99), `ProfileHeader.tsx:119` (0.94), `AccountMenu.tsx:78` (0.94), `TeamMemberCard.tsx:240` (0.99), `AgentIdentity.tsx:186,215` (0.94/0.98), `EntryActionMenu.tsx:72,90` (0.95), `EntryReactionPicker.tsx:76` (0.95), `AvatarPickerGrid.tsx:286` (0.90), `TunnelLanding.tsx:23` (0.98 + `hover:scale-[1.01]`). `whileTap`: `InputActionButton.tsx:268,322` (0.90), `CommandPaletteTrigger.tsx:24` (0.93), `RightPanelToggle.tsx:63` (0.93), `AvatarPickerGrid.tsx:347` (0.85), `navigation-layout.tsx:327` (0.98), `SessionRowFull.tsx:137` (0.98), `InboxBellPill.tsx:99` (0.97), `RemoteAccessAction.tsx:14` (0.98), `gen-ui/ui/nodes/ActionNodes.tsx:125` (0.97)

**Evidence.** Nine distinct scale targets (0.85, 0.90, 0.93, 0.94, 0.95, 0.97, 0.98, 0.99) through two unrelated mechanisms, with the CSS half sometimes carrying `duration-(--identity-press)` and sometimes nothing. The system already has the answer and it is three values: "**Press scales by target size:** `0.99` for a card, `0.98` for a row or chip, `0.94` for a mark used as a button" (`design-system.md:605`), timed by `--identity-press` (80ms). The identity surfaces follow it; everything else invented a number because `Button` never shipped one to inherit.

**Recommendation.** Publish the three-stop ladder as classes from `shared/ui` — `pressCard`/`pressRow`/`pressMark`, each `motion-safe:transition-[scale] duration-(--identity-press)` — and migrate the call sites. Prefer the CSS class over `whileTap` wherever the element is not already a `motion.*` component: CSS presses are free under the global reduced-motion reset, whereas every `whileTap` needs a JS gate. Drop `TunnelLanding`'s `hover:scale-[1.01]` in favour of `card-interactive`. `AvatarPickerGrid`'s overshoot is a sanctioned exception and stays.

### 5.8 — `Button`'s disabled state omits `cursor-not-allowed`, present on its siblings

**P3 · S · lens 9**
`apps/client/src/layers/shared/ui/button.tsx:8`; compare `input.tsx:16`, `checkbox.tsx:17`

**Evidence.** Verified: `Button` sets `disabled:pointer-events-none disabled:opacity-50`; `Input` and `Checkbox` both add `disabled:cursor-not-allowed`. `pointer-events-none` makes the omission mostly moot today, but the three cva strings disagree for no documented reason, and a future edit dropping `pointer-events-none` (to allow a `title` tooltip on hover, say) would silently regress the cursor too.

**Recommendation.** Add `disabled:cursor-not-allowed` to `button.tsx:8`, independent of whether `pointer-events-none` stays.

### 5.9 — Checkbox is the one control in the system with no state transition

**P3 · S · lens 10**
`apps/client/src/layers/shared/ui/checkbox.tsx:17,24`

**Evidence.** The root transitions `shadow` only, so the fill change from `bg-input/30` to `bg-primary` is instantaneous, and the indicator carries an explicit `transition-none` so the tick appears with no ramp. `animations.md:775` names the case directly: "Micro-interactions · 100-150ms · Button hover, **checkbox toggle**." `Switch` — its sibling in the same settings rows — animates both track colour and thumb position.

**Recommendation.** Add `transition-[color,background-color,box-shadow] duration-100` to the root and replace `transition-none` on the indicator with `motion-safe:transition-transform motion-safe:duration-100 data-[state=unchecked]:scale-75 data-[state=checked]:scale-100`. The end state still reads statically under reduced motion.

### 5.10 — Hand-rolled rows snap their hover with no transition, `CommandItem` included

**P3 · S · lens 10**
`apps/client/src/layers/shared/ui/command.tsx:109`, `shared/ui/sidebar.tsx:715`, `shared/ui/filter-bar/FilterBarAddFilter.tsx:82,106`, `features/mesh/ui/TopologyPanel.tsx:34`, `features/mesh/ui/AgentHealthDetail.tsx:145`, `features/chat/ui/message/MemoryRecallBlock.tsx:132,151`, `features/connections/ui/SessionConnectorsGroup.tsx:179`, `features/canvas/ui/CanvasJsonContent.tsx:61`

**Evidence.** Each is a `<button>` or menu item with `hover:bg-*` (or `data-[selected=true]:bg-accent` for `CommandItem`) and no `transition` in the same class string, so the background snaps between two values in one frame. `CommandItem` is the most visible: arrow-keying through any `Command` list — the palette, timezone pickers, mention lists — flashes the highlight from row to row. `design-system.md:820` prescribes hover as "Subtle. 150ms transition. A background tint step of 5-10%", and most of the app complies (`sidebar-row.tsx:555`, `table.tsx:49`, `provenance-chip.tsx:89`, `option-row.tsx:27`), which is why these read as a cheaper component.

**Recommendation.** Add `transition-colors duration-150` to each. `CommandItem` is a shared-primitive fix reaching every consumer at once.
