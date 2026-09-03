# Lens 10 — Motion & micro-interactions

Auditor: motion lens. Read-only pass over `apps/client/src`, 2026-09-03.

Ground truth read in full before auditing: `plans/ui-ux-audit-202609/00-charter.md`,
`contributing/animations.md`, `contributing/design-system.md` (Motion, Animation Catalog,
Identity → The interaction grammar, Anti-Patterns), `.claude/rules/components.md`,
`.claude/rules/fsd-layers.md`, `AGENTS.md`.

---

## Coverage

**Examined exhaustively**

- All 96 files in `layers/shared/ui/` — every one grepped for `motion`/`animate-`/`transition-`/
  `ease-`/`duration-`, and the 28 that carry no motion token at all enumerated and triaged by hand.
  Read in full: `button.tsx`, `sheet.tsx`, `dialog.tsx`, `alert-dialog.tsx`, `dropdown-menu.tsx`,
  `popover.tsx`, `select.tsx`, `context-menu.tsx`, `hover-card.tsx`, `tooltip.tsx`, `command.tsx`,
  `collapsible.tsx`, `tabs.tsx`, `segmented-control.tsx`, `bar-tab-strip.tsx`, `navigation-layout.tsx`,
  `identity-avatar.tsx`, `sidebar.tsx`, `sidebar-row.tsx`, `switch.tsx`, `checkbox.tsx`,
  `radio-group.tsx`, `progress.tsx`, `copy-button.tsx`, `sonner.tsx`, `skeleton.tsx`,
  `hover-border-gradient.tsx`, `ScanLine.tsx`, `truncated-output.tsx`, `settings-panel.tsx`.
- `apps/client/src/index.css` — all 40 `@keyframes`, every `@utility animate-*`, the
  `--msg-*` and `--identity-*` motion token families, the `card-interactive` / `focus-ring`
  utilities and both `prefers-reduced-motion` blocks. Every keyframe cross-checked for a live
  consumer.
- Whole-client inventories (all 940 component files): every `duration-*` class (130 uses),
  every `ease-*` class, every `whileTap` / `whileHover` / `active:scale-*`, every `layoutId`,
  every `repeat: Infinity`, every `staggerChildren`, every `transition-all`, every `exit=` that
  has no `AnimatePresence` in its own file (then traced to its call site), every
  `animate={{ width | height | 'auto' }}`, and every `hover:bg-*` class blob with no `transition`
  in it (scripted scan, 45 candidates, hand-triaged down to the real hand-rolled controls).
- The 208 files importing `motion/react`, listed and bucketed; the 60 files calling
  `useReducedMotion` verified against the two contradictory doc prescriptions.
- Shell + navigation motion: `App.tsx`, `AppShell.tsx`, `RightPanelContainer.tsx`,
  `MobileTabBar.tsx`, `MobileTabsLayout.tsx`, `navigation-layout.tsx`, `bar-tab-strip.tsx`.

**Sampled**

- Feature/widget slices: composer + chat input, conversation/LiveLane, ask/approvals, inbox,
  tasks, marketplace, mesh, settings, onboarding, discovery, dashboard-sidebar, team-roster,
  command-palette, jump-back-in, right-panel, profile, connections, relay. Read where a grep hit
  looked load-bearing; not every file in every slice was opened.

**Skipped, and why**

- `dev/` playground showcases — lens 6 owns them. Excluded from all scripted scans.
- `layers/features/gen-ui/**` — agent-generated widget rendering with its own spec'd motion
  vocabulary (`specs/gen-ui-tier1`, `lib/widget-motion.ts`). Its shakes, wobbles and infinite
  loops are a deliberate separate language; relitigating them is out of bounds per charter rule 4.
- `layers/features/chat/ui/chips/**` and the `--msg-*` keyframes (reaction pop, press-release,
  thread-line-draw, count-flip, capsule-in) — all spec-backed with written design records
  (`specs/chat-touch-chips/design-decisions.md`, the message design record cited inline in
  `index.css`). Their overshoot curves are decided, not accidental.
- `ScanLine` — its expressiveness is explicitly signed off in
  `specs/background-agent-indicator/01-ideation.md:46`.
- `HoverBorderGradient` — sanctioned by name in `design-system.md` as the one branded moment.
- `NavigationLayoutContent`'s instant panel swap — a documented decision with a real a11y reason
  (`navigation-layout.tsx:434-449`). I propose only an enter-only fade that does not reintroduce
  the duplicate-id problem it describes.
- `apps/site` motion (`specs/dynamic-motion-enhancements`) — different app, out of scope.

**Overall read.** This is a well-motioned codebase — LiveLane, the dashboard sidebar, the
command palette, the roster FLIP and the message layer are all thoughtful, documented and
reduced-motion-correct. The gaps are almost entirely in the _shared primitives_ and the
_general app chrome_, which never got the same attention as the chat surfaces: the base
`Button` has no press state, `Collapsible` animates nothing, `Sheet` opens at 500ms, and the
phone's navigation answers a tap with silence. Nothing here proposes new drama; most fixes
delete or retime motion rather than add it.

---

## Findings

### [P1/S] The phone's only navigation answers a tap with nothing

**Files:** `apps/client/src/layers/widgets/mobile-tabs/ui/MobileTabBar.tsx:90`

**Current state.** Each of the four destination buttons carries exactly
`'focus-ring relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors duration-150'`.
No `active:` state, no scale, no tint step. The only change on selection is
weight + colour (`:99-108`), which lands _after_ the route resolves. `MobileTabsLayout` swaps
panels with `visibility: hidden` (`MobileTabsLayout.tsx:16-22`), so the panel change is instant
too. On touch there is no hover to stand in for the missing press.

**Why it falls short.** Below 768px this bar _is_ the cockpit — it replaced the drawer
entirely (`AppShell.tsx:775-790`). The design system's Animation Catalog prescribes
"Button press: Scale to 0.97 on active, spring back", and `SidebarMenuButton` — the same
control on desktop — already implements it (`sidebar.tsx:490`,
`active:scale-[0.97] active:duration-100`). The most-touched control in the product is the
one that gives no physical answer, and the phone surface is launch-critical
(AGENTS.md §Product state). A tap with no acknowledgement is what makes people tap twice.

**Recommendation.** Add `motion-safe:transition-transform motion-safe:active:scale-[0.96]`
to the tab button (0.96 rather than 0.97 because the target is a large full-height column,
and the identity grammar's ladder scales press by target size —
`design-system.md:605`). No new tokens, no new library, one class string. Optionally pair
with the tint step the desktop row already uses (`active:bg-sidebar-accent`) so the feedback
survives `prefers-reduced-motion`, which drops the scale.

---

### [P2/S] `Button` — the app's most-used primitive — has no press state at all

**Files:** `apps/client/src/layers/shared/ui/button.tsx:8`

**Current state.** The base cva string is `... transition-all ...` with hover backgrounds per
variant (`:12-21`) and a focus ring, but no `active:` rule anywhere. Press feedback in this app
is entirely call-site-invented: 18 hand-written `active:scale-*` sites and 12 `whileTap` sites,
none of them on `Button`.

**Why it falls short.** `design-system.md:204` states the rule as a catalog entry —
"**Button press:** Scale to 0.97 on active, spring back" — and it is simply not implemented.
Every consumer that wants it re-derives it (`TunnelLanding.tsx:23`,
`ProfileRow.tsx:173`, `TodayZone.tsx:182`, `SessionRowCompact.tsx:95`), which is how the value
ladder in the next finding got to nine different numbers.

**Recommendation.** Put the press in the primitive:
`motion-safe:active:scale-[0.97] motion-safe:active:duration-100` on the base string, and
narrow `transition-all` to `transition-[color,background-color,border-color,box-shadow,transform]`
at the same time (see the `transition-all` finding). Then delete the hand-rolled duplicates at
the call sites that only exist because the primitive was silent.

---

### [P2/S] `Collapsible` animates nothing — 55 call sites snap open with a hard layout jump

**Files:** `apps/client/src/layers/shared/ui/collapsible.tsx:15-20` (`CollapsibleContent`),
`contributing/animations.md:14`
Consumers (17 production files, 55 uses): `settings/ui/tools/ToolGroupRow.tsx`,
`settings/ui/runtimes/RuntimeCardView.tsx`, `settings/ui/external-mcp/SetupInstructions.tsx`,
`settings/ui/external-mcp/ExternalMcpCard.tsx`, `feedback/ui/FeedbackDialog.tsx`,
`profile/ui/InjectionPreview.tsx`, `agent-creation/ui/AgentGallery.tsx`,
`agent-creation/ui/NamingStep.tsx`, `relay/ui/ConfigFieldInput.tsx`,
`relay/ui/adapter/AdapterCardError.tsx`, `onboarding/ui/SystemRequirementsStep.tsx`,
`schedule-approval/ui/ScheduleApprovalCard.tsx`, `shared/ui/field-card.tsx`,
`connections/ui/AccountsRegion.tsx`, `connections/ui/MessagingRegion.tsx`,
`entities/runtime/ui/RuntimeSetupDialog.tsx`, `entities/runtime/ui/CommandTransparencyNote.tsx`

**Current state.** `CollapsibleContent` is a bare pass-through to the Radix primitive with no
className at all. Radix exposes `--radix-collapsible-content-height` and
`data-[state=open|closed]` precisely so a consumer can animate it; nothing does. Every
collapsible in Settings, Connections, onboarding and agent creation therefore expands by
teleporting its content into existence and shoving everything below it down in one frame.
`contributing/animations.md:14` points readers at "Accordion animations — CSS keyframes in
`index.css`"; **there are no accordion keyframes in `index.css`** (verified: zero matches for
`accordion`), so the documented pattern is a dangling reference.

**Why it falls short.** The design system lists "Expand/collapse" at 300ms in its own timing
table (`design-system.md:181`) and the animations guide devotes a whole section to
"Height Collapse Animation" (`animations.md:416-452`). The chat layer honours that
(`ToolCallCard`, `CollapsibleCard`, `QueuePanel`); the settings/connections layer does not,
purely because the shared primitive is empty. An unannounced layout jump is the single most
common "this feels cheap" tell in an otherwise calm UI.

**Recommendation.** Add the two keyframes to `index.css` (`collapsible-down`: `height: 0` →
`var(--radix-collapsible-content-height)`; `collapsible-up`: the reverse) and put
`overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down`
on `CollapsibleContent` at 200ms `cubic-bezier(0, 0, 0.2, 1)` — the ease-out the
animations guide names for height (`animations.md:448`: spring on height overshoots). The
global reduced-motion reset in `index.css:1815-1822` collapses it to 0.01ms for free. Then fix
the dangling doc reference in `animations.md:14`.

---

### [P2/S] The Sheet opens over half a second while its own scrim finishes in 150ms

**Files:** `apps/client/src/layers/shared/ui/sheet.tsx:61` (content),
`sheet.tsx:36` (overlay)
Consumers riding the default: `marketplace/ui/PackageDetailSheet.tsx:406`,
`canvas/ui/AgentCanvas.tsx:218`, `dashboard-attention/ui/FailedRunDetailSheet.tsx:65`,
`dashboard-attention/ui/OfflineAgentDetailSheet.tsx:80`, `relay/ui/SetupGuideSheet.tsx:33`,
`relay/ui/MessagingConnections.tsx:328`, `right-panel/ui/RightPanelContainer.tsx:209`
(the whole mobile/Obsidian right panel)

**Current state.** `SheetContent` ships
`transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500`.
`SheetOverlay` sets `fade-in-0` with **no duration**, so it takes tw-animate's 150ms default.
Opening any sheet: the scrim is fully black at 150ms and the panel is still sliding for another
350ms. Exactly one call site retimes it — `ProfileSheet` overrides to 300ms on its own
className, and `design-system.md:619` records that as a deliberate call-site decision
("Changing `sheet.tsx` would have re-timed Settings' panels too — a decision about every sheet
in the app, which this was not").

**Why it falls short.** 500ms is 200ms past the design system's own ceiling — its timing table
tops out at "Slow · 300ms · Expand/collapse, overlays" (`design-system.md:181`) and
`animations.md:778` sets "Drawer/overlay slide · 200ms". `ease-in-out` on an entrance also
contradicts the easing table, which reserves ease-out for entrances (`design-system.md:188`).
The doc explicitly parked this as a decision nobody had made yet. This audit is the place to
make it.

**Recommendation.** Retime the primitive to `data-[state=open]:duration-200
data-[state=closed]:duration-150`, swap `ease-in-out` for the ease-out curve on open, and give
`SheetOverlay` a matching duration so scrim and panel land together. Then delete
`ProfileSheet`'s override, which exists only to escape the default.

---

### [P2/S] The send button and the top-bar chrome grow 10% on hover — the loudest motion in the app

**Files:** `apps/client/src/layers/features/composer/ui/InputActionButton.tsx:267` (stop),
`InputActionButton.tsx:321` (send), `right-panel/ui/RightPanelToggle.tsx:62`,
`top-nav/ui/CommandPaletteTrigger.tsx:23`

**Current state.** Four always-visible chrome controls carry `whileHover={{ scale: 1.1 }}`, and
the two composer buttons pair it with `whileTap={{ scale: 0.9 }}`.

**Why it falls short.** `design-system.md:206` specifies the send button by name: "Subtle scale
pulse on hover (**1.05**), quick press feedback". The shipped value is double that. `whileTap`
0.9 is a 10% squash against a documented 0.97 press and against the identity grammar's ladder,
whose most aggressive stop is 0.94 for a mark used as a button (`design-system.md:605`). A
control that jumps 10% under the cursor is the Calm Tech anti-pattern "Dramatic animations"
(`design-system.md:30`) sitting on the two surfaces a user's pointer visits most.

**Recommendation.** Bring all four to `whileHover={{ scale: 1.05 }}` / `whileTap={{ scale: 0.97 }}`,
or — better for the two icon-only top-bar controls — drop the hover scale entirely and let the
existing `hover:bg-accent` tint do the work, which is what the rest of the app's chrome does.
Keep the press. `AvatarPickerGrid.tsx:346` (`whileHover 1.25`) is deliberately exempt: the
avatar picker is one of the two sanctioned overshoot moments (`design-system.md:575`).

---

### [P2/S] Two shipped overlays declare exit animations that can never run

**Files:**
`apps/client/src/layers/features/jump-back-in/ui/JumpBackInPopover.tsx:242-245` +
call site `widgets/room-view/ui/ChannelComposer.tsx:418`;
`apps/client/src/layers/entities/discovery/ui/CandidateCard.tsx:64-69` +
call site `features/onboarding/ui/ConversationDiscoveryBeat.tsx:163`

**Current state.**

- `JumpBackInPopover` has `initial`/`animate` and **no `exit` at all**, and its call site renders
  it as a bare `{jumpBackIn.isOpen && (…)}` with no `AnimatePresence`. It fades in over 150ms and
  then vanishes in a single frame. Eleven lines above it in the _same file_
  (`ChannelComposer.tsx:404-412`) `MentionPalette` — a panel of the same size, in the same slot —
  is correctly wrapped and animates both ways.
- `CandidateCard` declares `exit={{ opacity: 0, y: -6 }}`. On `/connections` its parent wraps the
  list in `<AnimatePresence mode="popLayout">` (`DiscoveryView.tsx:354`) and the exit plays. In
  onboarding the same component is mapped with no `AnimatePresence`
  (`ConversationDiscoveryBeat.tsx:159-168`), so approving a project makes the card disappear
  instantly and the ones below jump up.

**Why it falls short.** `animations.md:562-578` names this exact failure ("Don't forget
AnimatePresence for exit animations — Exit animation won't work!"), and the repo already knows
the trap well enough to comment on it (`SessionComposer.tsx:635-639`: "a component that returns
null is still mounted, so AnimatePresence never saw it leave"). The onboarding case is the worse
of the two: it is the first surface a new user touches, and it is the one that got the abrupt
treatment while the settings page got the polished one.

**Recommendation.** Give `JumpBackInPopover` the same `exit={{ opacity: 0, scale: 0.98, y: 4 }}`
its three sibling palettes use (`MentionPalette.tsx:51`, `CommandPalette.tsx:47`,
`FilePalette.tsx:48` — identical values already) and wrap the call site in `AnimatePresence`.
Wrap the onboarding candidate map in `<AnimatePresence mode="popLayout">`, matching
`DiscoveryView`. Both are two-line changes.

---

### [P2/M] The three largest moving surfaces all ease-in-out an entrance

**Files:** `apps/client/src/layers/shared/ui/sidebar.tsx:217` and `:228`
(`transition-[width] duration-300 ease-in-out`, `transition-[left,right,width] duration-300 ease-in-out`),
`features/right-panel/ui/RightPanelContainer.tsx:21` and `:23`
(`'flex-grow 300ms ease-in-out'`, `'opacity 300ms ease-in-out'`),
`shared/ui/sheet.tsx:61` (`transition ease-in-out`),
`shared/ui/identity-avatar.tsx:108` (`duration-500 ease-in-out`)

**Current state.** `ease-in-out` appears in exactly six client files, and four of them are the
app's biggest pieces of moving chrome. Everything else in the client uses `ease-out` (14 uses)
or a spring.

**Why it falls short.** The easing table is unambiguous: `ease-out cubic-bezier(0, 0, 0.2, 1)`
for "Entrances (fast start, gentle stop)", `ease-in` for exits (`design-system.md:186-190`).
`ease-in-out` starts slowly, which is why the sidebar and the right panel feel like they hesitate
before moving. The sidebar is also 300ms against a documented 200ms ("Sidebar toggle: Width
transition 200ms, content fades" — `design-system.md:208`), so it is out of spec on both axes.

**Recommendation.** One pass across those four files: entrances to
`ease-[cubic-bezier(0,0,0.2,1)]`, exits to `ease-[cubic-bezier(0.4,0,1,1)]`, and bring the
sidebar width to the documented 200ms. Effort is M rather than S only because the sidebar and
right panel both have browser tests that measure their settled geometry and should be re-run.

---

### [P2/M] One height-collapse gesture ships at three durations, under three different local names

**Files (all the same visual gesture — `height: 0 ↔ 'auto'` + opacity):**
`features/chat/ui/tools/ToolCallCard.tsx:66` (0.2s),
`features/chat/ui/input/QueuePanel.tsx:69` (0.2s, no easing),
`features/tasks/ui/TaskBuilder.tsx:71` (`ANIMATION_TRANSITION`, 0.2s) used at `:395,:425,:462`,
`features/chat/ui/message/ErrorMessageBlock.tsx:9` (`collapseTransition`, 0.25s),
`features/ask/ui/QuestionPrompt.tsx:12` (`collapseTransition`, 0.25s — a byte-identical second
definition of the same constant),
`features/tasks/ui/TaskRow.tsx:339` (0.3s),
`features/chat/ui/primitives/CollapsibleCard.tsx:86` (0.3s),
plus inline variants in `settings/ui/TunnelSettings.tsx:10`, `settings/ui/TunnelSetup.tsx:8`,
`settings/ui/TunnelConnected.tsx:37`, `chat/ui/tasks/TaskDetail.tsx:92`,
`chat/ui/tasks/TaskDetailPanel.tsx:20`, `chat/ui/tasks/TaskActiveForm.tsx:16`,
`chat/ui/tasks/TaskListPanel.tsx:77`

**Current state.** Fifteen call sites hand-roll the same three-line variant object. Durations
are 200ms, 250ms and 300ms depending on which file you land in; two files declare an identically
named `collapseTransition` constant independently.

**Why it falls short.** `animations.md:449` says it outright — "Define variants at **module
scope** (not inline) to avoid object recreation on every render" — and the guide already
publishes the canonical `collapseVariants` + `collapseTransition` shape
(`animations.md:420-427`). Nothing exports it, so every author retypes it and picks a number.
A user expanding a tool card and then a task row sees the same gesture at two speeds.

**Recommendation.** Export `COLLAPSE_VARIANTS` and `COLLAPSE_TRANSITION` (one duration —
200ms, `cubic-bezier(0, 0, 0.2, 1)`) from `layers/shared/lib`, alongside the `--msg-*` and
`--identity-*` families that already do this properly, and replace all fifteen. Pairs naturally
with the `Collapsible` primitive fix above so CSS and JS collapses agree.

---

### [P2/S] The Inbox staggers an uncapped list, so a busy inbox appears to load slowly

**Files:** `apps/client/src/layers/features/inbox/ui/InboxList.tsx:30` and `:150`,
`features/inbox/ui/InboxRow.tsx:14-15`

**Current state.** `staggerContainer` sets `staggerChildren: 0.03` and the container wraps
`items.map(...)` with no slice and no per-index cap; `InboxRow` declares
`initial: { opacity: 0, y: 6 }` as its child half. Thirty notifications means the last row waits
900ms; sixty means 1.8s.

**Why it falls short.** `animations.md:327` states the rule — "Limit stagger to the first 8
visible items — items beyond index 7 render immediately without animation to avoid excessive
delay" — and the rest of the app obeys it: `TasksList.tsx:21,140` caps at 8,
`PackageGrid.tsx:19,152` caps at 20, `PulseAttentionSection.tsx:56-58` and
`ApprovalList.tsx:45` cap by slicing. Inbox is the one uncapped list, and it is also the list
most likely to be long. It reads as latency, not as motion.

**Recommendation.** Adopt the `TasksList` shape exactly: pass `index` down and give
`variants={index < 8 ? staggerItem : undefined}`. While there, `InboxList.tsx:132-134` renders a bare
`"Loading…"` string that is replaced by a staggered list in one frame — the two states should
share a shape, but that is lens 9's call.

---

### [P2/S] `card-interactive` gives a hover-only lift with no focus-visible twin, over `transition: all`

**Files:** `apps/client/src/index.css:548-554`
Consumers: `features/marketplace/ui/PackageCard.tsx:110`,
`features/agent-creation/ui/GalleryCard.tsx:57`,
`features/runtime-connect/ui/OpenCodeProviderPicker.tsx:174`,
`features/connections/ui/ServiceGrid.tsx:93`

**Current state.**

```css
@utility card-interactive {
  transition: all 150ms ease-out;
  &:hover {
    box-shadow: var(--elevation-elevated);
    border-color: hsl(var(--border) / 0.8);
  }
}
```

No `:focus-visible` branch. `PackageCard` adds a focus _ring_ (`:113`) but the informational
half — the elevation and border step that says "this card is the one under your pointer" — never
fires for a keyboard user.

**Why it falls short.** `design-system.md:607` makes this a rule, not a preference: "If an area
has a hover state, it has a focus-visible twin conveying the same information — a keyboard user
must never learn less than a mouse user … the _informational_ half (a colour step, an underline,
a lift) gets an explicit `focus-visible:` twin beside every `hover:`." The roster card is cited
in that same paragraph as the worked example. The shared utility every other card uses does not
follow it. Separately, `transition: all` on a card animates border-width, padding and any layout
property a consumer adds — the anti-pattern `TeamMemberCard.tsx:225` explicitly comments on
avoiding.

**Recommendation.** Add `&:focus-visible, &:has(:focus-visible) { … same two declarations … }`
to the utility, and narrow the property list to
`box-shadow, border-color, transform`. Add the missing `-1px` lift while you are there so the
utility actually implements the Surface tier the grammar defines (`design-system.md:581`).

---

### [P2/M] Press feedback has no ladder — nine scale values across two mechanisms

**Files:**
CSS `active:scale-*`: `sidebar.tsx:490` (0.97), `sidebar-row.tsx:555` (0.98),
`sidebar-row.tsx:681,700` (0.94), `TodayZone.tsx:182` (0.98), `SessionRowCompact.tsx:95` (0.98),
`ProfileRow.tsx:173` (0.99), `ProfileHeader.tsx:119` (0.94), `AccountMenu.tsx:78` (0.94),
`TeamMemberCard.tsx:240` (0.99), `AgentIdentity.tsx:186` (0.94) and `:215` (0.98),
`EntryActionMenu.tsx:72,90` (0.95), `EntryReactionPicker.tsx:76` (0.95),
`AvatarPickerGrid.tsx:286` (0.90), `TunnelLanding.tsx:23` (0.98 + `hover:scale-[1.01]`)
Motion `whileTap`: `InputActionButton.tsx:268,322` (0.90), `CommandPaletteTrigger.tsx:24` (0.93),
`RightPanelToggle.tsx:63` (0.93), `AvatarPickerGrid.tsx:347` (0.85),
`navigation-layout.tsx:327` (0.98), `SessionRowFull.tsx:137` (0.98),
`InboxBellPill.tsx:99` (0.97), `RemoteAccessAction.tsx:14` (0.98),
`gen-ui/ui/nodes/ActionNodes.tsx:125` (0.97)

**Current state.** Nine distinct scale targets (0.85, 0.90, 0.93, 0.94, 0.95, 0.97, 0.98, 0.99)
delivered through two unrelated mechanisms, with the CSS half sometimes carrying
`duration-(--identity-press)` and sometimes nothing.

**Why it falls short.** The system already has the answer and it is three values, not nine:
"**Press scales by target size:** `0.99` for a card, `0.98` for a row or chip, `0.94` for a mark
used as a button" (`design-system.md:605`), timed by `--identity-press` (80ms). The identity
surfaces follow it; everything else invented a number, because the base `Button` never shipped
one for them to inherit (see the `Button` finding). `TunnelLanding.tsx:23` additionally _grows_
a full-width card 1% on hover, which the Surface tier answers with a lift and a border step, not
a scale.

**Recommendation.** Publish the three-stop ladder as classes from `shared/ui` the way
`identityMarkRing` already is (`identity-avatar.tsx:90-95`) — `pressCard` / `pressRow` /
`pressMark`, each `motion-safe:transition-[scale] duration-(--identity-press)` — and migrate the
call sites onto it. Replace `whileTap` with the CSS class wherever the element is not otherwise a
`motion.*` component; CSS presses are free under the global reduced-motion reset, whereas every
`whileTap` needs the JS gate. Drop `TunnelLanding`'s `hover:scale-[1.01]` for `card-interactive`.

---

### [P3/S] Dead motion CSS — three keyframe blocks with no consumer anywhere

**Files:** `apps/client/src/index.css:817-827` (`@keyframes shimmer-pulse`),
`index.css:797-815` (`@keyframes breathe` + `.dorkbot-avatar` + `.dorkbot-avatar.reacting`),
`index.css:1169-1180` (`@keyframes health-pulse` + `.animate-health-pulse`)

**Current state.** Verified by grepping the whole client (`.ts`, `.tsx`, `.css`):
`shimmer-pulse` is referenced only by its own declaration; `.dorkbot-avatar` and
`.dorkbot-avatar.reacting` match no element in any component; `.animate-health-pulse` matches
nothing. `health-pulse` also hardcodes `rgb(16 185 129 / 0.4)` — the emerald of the mesh-health
ring that `design-system.md:555` records as removed ("That ring is gone (DOR-1052) — health is
drawn where health is the subject"). This is its leftover.

**Why it falls short.** AGENTS.md §Quality Standard: "no dead code, no tolerated legacy patterns
— when something is superseded, remove it." Live CSS that animates nothing is also a trap: the
next author greps `health-pulse`, finds a ready-made pulse utility, and reintroduces a signal the
design system deliberately deleted.

**Recommendation.** Delete all three blocks (~40 lines). If the DorkBot breathe is wanted again,
it should come back as `animate-tasks` (`index.css:860-874`), which is the app's one
"work is happening" breath and is documented as such.

---

### [P3/S] `transition-all` in 26 places, against the rule the codebase states out loud

**Files:** `shared/ui/button.tsx:8`, `shared/ui/tabs.tsx:33`, `shared/ui/progress.tsx:28`,
`shared/ui/input-otp.tsx:45`, `shared/ui/option-row.tsx:27`,
`shared/ui/compact-result-row.tsx:24`, `shared/ui/responsive-dialog.tsx:125`,
`shared/ui/route-error-fallback.tsx:68`, `shared/ui/link-safety-modal.tsx:74`,
`shared/ui/sidebar.tsx:288`, `index.css:549`, plus 15 feature files
(`chat/ui/tasks/TaskProgressHeader.tsx:34`, `chat/ui/tasks/InlineKillButton.tsx:75`,
`chat/ui/tasks/AgentRunner.tsx:266`, `chat/ui/tasks/BackgroundTaskBar.tsx:224`,
`chat/ui/message/FileAttachmentList.tsx:70`, `chat/ui/primitives/CompactPendingRow.tsx:27`,
`chat/ui/primitives/CollapsibleCard.tsx:52`, `ask/ui/AskCard.tsx:184`,
`marketplace/ui/PackageCard.tsx:112`, `agent-creation/ui/GalleryCard.tsx:58`, …)

**Current state.** `transition-all` transitions every animatable property, layout ones included.
On `Button` it is doubly wrong: `RESPONSIVE_SIZE_CLASSES` (`button.tsx:53-58`) changes `height`
at the `md:` breakpoint, so dragging a window across 768px animates the height of every button on
screen.

**Why it falls short.** The house rule is already written, in the codebase, by the component that
got the most motion attention: `TeamMemberCard.tsx:225` — "…rather than `transition-all`, so what
moves stays auditable; every one of…". `animations.md:580-600` lists animating layout properties
as an explicit anti-pattern. This is a consistency-and-performance cleanup, not a visual change.

**Recommendation.** Replace each with an explicit property list. The overwhelmingly common
correct answer is `transition-[color,background-color,border-color,box-shadow]`; add `transform`
where a press or lift is involved. Low risk, mechanical, and it makes the diff of any future
motion change readable.

---

### [P3/S] `IdentityAvatar`'s disc crossfades its colour over 500ms — a fourth speed in a three-speed system

**Files:** `apps/client/src/layers/shared/ui/identity-avatar.tsx:108`

**Current state.** The base cva string is
`'relative inline-flex shrink-0 items-center justify-center transition-[background-color] duration-500 ease-in-out'`.
A Mark-tier disc later merges `duration-(--identity-answer)` (120ms) from `identityMarkRing`
(`:92`, `:94`) and tailwind-merge lets that win — but every _non-Mark_ disc, which is the large
majority (feed avatars, roster faces, message authors, mention pills' discs), keeps the 500ms
`ease-in-out`.

**Why it falls short.** The section immediately below it states the constraint in its own
heading: "**Three speeds and two curves, in `index.css`. There is no fourth.**"
(`design-system.md:565`) — 80ms press, 120ms answer, 200ms settle. 500ms is more than double the
slowest, and `ease-in-out` is not one of the two curves. It is also the only place in the client
where a colour change on a _non-interactive_ element is animated, which
`design-system.md:226` lists under "What NOT to Animate — Colors on non-interactive elements".

**Recommendation.** Change the base to
`transition-[background-color] duration-(--identity-settle) ease-(--identity-ease-standard)`,
or drop the base transition entirely and let only the Mark-tier class carry one. Either way the
disc stops being the exception to its own section.

---

### [P3/S] Dropdown menus zoom from their own middle; every other overlay grows out of its trigger

**Files:** `apps/client/src/layers/shared/ui/dropdown-menu.tsx:19-25` (`DropdownMenuContent`),
compare `dropdown-menu.tsx:132-139` (`DropdownMenuSubContent`, correct),
`popover.tsx:30`, `select.tsx:45`, `hover-card.tsx:42`, `context-menu.tsx:67`, `tooltip.tsx:43`

**Current state.** `DropdownMenuContent` sets `zoom-in-95` with no
`origin-(--radix-dropdown-menu-content-transform-origin)`, so it scales from its geometric
centre, and its slide list covers only `data-[side=bottom]` and `data-[side=top]` — a dropdown
that Radix flips to `side="left"` or `"right"` near a viewport edge gets no directional slide at
all. Its own `SubContent`, twelve lines further down, has all four sides. Popover, select,
hover-card, context-menu and tooltip all set the origin variable and all four sides.

**Why it falls short.** The transform origin is what makes an overlay read as _coming from the
thing you clicked_. Dropdowns are the most-opened overlay in this app (every kebab, every
`NewMenu`, every row menu), and they are the one class that does not do it.

**Recommendation.** Add `origin-(--radix-dropdown-menu-content-transform-origin)` and the two
missing side rules, making `DropdownMenuContent` identical in motion to `PopoverContent`. One
line changed, one line added.

---

### [P3/M] Three tab controls, three unrelated motion answers

**Files:** `shared/ui/tabs.tsx:33` and `:44-57` (Radix Tabs — trigger crossfades via
`transition-all`, `TabsContent` has **no** enter animation),
`shared/ui/segmented-control.tsx:70` (crossfade only:
`motion-safe:transition-[background-color,color,box-shadow] motion-safe:duration-150`),
`shared/ui/bar-tab-strip.tsx:229` (`layoutId` sliding underline, spring)

**Current state.** The app ships three ways to pick one of N side-by-side options, and each
answers differently: the shell's One Bar slides an indicator, the segmented control (Trust Dial's
three stops) crossfades a raised thumb in place, and the shadcn Tabs primitive crossfades a
trigger and swaps its panel with zero transition.

**Why it falls short.** These sit within one screen of each other (Settings dialog, Trust Dial,
Home bar). A user learns "selection slides here, snaps there" for no reason they can name — the
opposite of "inevitable design" (`design-system.md:14`). The codebase already owns the good
answer twice (`bar-tab-strip.tsx:229`, `navigation-layout.tsx:361`).

**Recommendation.** Give `SegmentedControlItem` the `layoutId` thumb — a `motion.div` with
`layoutId` behind the checked segment, `LayoutGroup`-scoped and spring 280/32, the same preset
the nav pill uses — so the raised surface _travels_ between stops instead of blinking across.
Give `TabsContent` an enter-only fade (`data-[state=active]:animate-in fade-in-0 duration-150`);
no exit, so no two-panels-mounted problem. Leave `BarTabStrip` alone; it is the reference.

---

### [P3/M] Route content hard-cuts while the chrome describing it cross-fades

**Files:** `apps/client/src/AppShell.tsx:783` (`<Outlet />`), compare `AppShell.tsx:602-624`
(sidebar body directional slide, 200ms) and `AppShell.tsx:711-736` (header content crossfade,
100ms)

**Current state.** `AppShell`'s own doc comment says it: "The sidebar body directional-slides
(200ms) and header content cross-fades on route change via AnimatePresence"
(`AppShell.tsx:215-217`). The `<Outlet />` inside `<Panel id="main-content">` has nothing. So
navigating Home → Team → Marketplace slides the sidebar, fades the header, and replaces the
entire page body in a single frame.

**Why it falls short.** The chrome moves and the content it describes does not, which reads as
the page failing to keep up with its own navigation. `design-system.md:210` already establishes
in-page transitions as part of the language (the palette's 150ms directional slide), and
`animations.md:775` gives them a row in the duration table.

**Recommendation.** Wrap the outlet in `<AnimatePresence mode="wait" initial={false}>` with a
`motion.div key={pathname}` doing opacity only — `{ duration: 0.12, ease: 'easeOut' }`, no
translate. Opacity-only is the safe form here: the routed page owns its own scroller, and a
transform on the wrapper would create a containing block that breaks the `fixed` PIP layer and
the panel-group measurement. Effort M because it needs a browser check against the right panel,
the PIP dock and scroll restoration, not because the change is large.

---

### [P3/S] Hand-rolled rows snap their hover with no transition

**Files (verified hand-written elements, not `Button` overrides):**
`features/mesh/ui/TopologyPanel.tsx:34`, `features/mesh/ui/AgentHealthDetail.tsx:145`,
`features/chat/ui/message/MemoryRecallBlock.tsx:132` and `:151`,
`features/connections/ui/SessionConnectorsGroup.tsx:179`,
`features/canvas/ui/CanvasJsonContent.tsx:61`,
`shared/ui/sidebar.tsx:715` (`SidebarMenuSubButton`),
`shared/ui/command.tsx:109` (`CommandItem` — `data-[selected=true]:bg-accent`, no transition),
`shared/ui/filter-bar/FilterBarAddFilter.tsx:82` and `:106`

**Current state.** Each is a `<button>` or menu item with `hover:bg-*` (or, for `CommandItem`,
`data-[selected=true]:bg-*`) and no `transition` in the same class string. The background snaps
between two values in one frame. `CommandItem` is the most visible: arrow-keying through any
`Command` list — timezone pickers, mention lists — flashes the highlight from row to row.

**Why it falls short.** `design-system.md:820` prescribes hover as "Subtle. 150ms transition. A
background tint step of 5-10%", and `design-system.md:179` puts hover states at the 150ms "Fast"
stop. Most of the app does this (`sidebar-row.tsx:555`, `table.tsx:49`, `provenance-chip.tsx:89`,
`option-row.tsx:27` …), which is exactly why the ones that don't read as a different, cheaper
component.

**Recommendation.** Add `transition-colors duration-150` to each of the ten sites. For
`CommandItem`, this is a shared-primitive fix that reaches every consumer at once.

---

### [P3/S] A shared primitive hardcodes a global `layoutId`

**Files:** `apps/client/src/layers/shared/ui/navigation-layout.tsx:361`
(`layoutId="nav-layout-active-pill"`, inside the `LayoutGroup` at `:141-148`),
consumer `shared/ui/tabbed-dialog.tsx:177`
Compare `shared/ui/bar-tab-strip.tsx:41` (`indicatorLayoutId: string` — a _required prop_)

**Current state.** `NavigationLayout` — the chassis under `TabbedDialog` and therefore under
Settings — burns a fixed string into a `shared/ui` primitive. The surrounding `<LayoutGroup>`
carries no `id`, so it groups measurement but does not namespace the id; two `NavigationLayout`
instances mounted at once would share one pill and teleport it between them. `BarTabStrip`, built
later, made the id a required prop precisely to avoid this.

**Why it falls short.** `animations.md:272` gives the rule ("Wrap the list in `<LayoutGroup>` to
scope the `layoutId` and prevent conflicts with other layout animations"), and the identity
grammar's own hard-won lesson is that a bare group selector matching more than you meant is a
bug that only a browser finds (`design-system.md:603`). The failure is latent today because
`DialogHost` opens one dialog at a time — but the primitive is exported for anyone.

**Recommendation.** Follow `BarTabStrip`: take the id as a prop, defaulting to a `React.useId()`
value, and/or pass it to `<LayoutGroup id={…}>`. Same treatment is worth considering for
`layoutId="active-session-bg"` (`SessionRowFull.tsx:115`) and
`layoutId="cmd-palette-selection"` (`AgentCommandItem.tsx:57`), both currently safe by
single-instance convention rather than by construction.

---

### [P3/S] The copy button's confirmation is a hard cut — the cheapest delight in the app, unspent

**Files:** `apps/client/src/layers/shared/ui/copy-button.tsx:32-34` and `:49-50`

**Current state.** `CopyButtonIcon` returns one of three different lucide icons with no
transition of any kind (`if (copied) return <Check … />`), and the button's own className carries
only `transition-colors`. Copy → check → copy back is three instantaneous swaps.

**Why it falls short.** This is the archetypal "did it work?" micro-interaction, and it appears
on every code block, every path breadcrumb, every id, every memory row. It is also the one moment
in the app where a tiny piece of motion is _carrying information_ (the action succeeded) rather
than decorating, which is exactly what the design language says motion is for
(`design-system.md:169`: "Things should move because they _are_ moving — … responding to
interaction").

**Recommendation.** Wrap the icon in `AnimatePresence mode="wait"` keyed on the state, with
`initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.12 }}`. Under
`MotionConfig reducedMotion="user"` the scale drops and the crossfade remains, which still reads.
(Also worth flagging to the tokens lens: `text-green-500` at `:32` is a raw Tailwind colour where
`text-status-success` exists.)

---

### [P3/S] Checkbox is the one control in the system with no state transition at all

**Files:** `apps/client/src/layers/shared/ui/checkbox.tsx:17` and `:24`

**Current state.** The root transitions `shadow` only — so the fill change from `bg-input/30` to
`bg-primary` on check is instantaneous — and the indicator carries an explicit
`transition-none`, so the tick appears with no ramp.

**Why it falls short.** `animations.md:775` names this case in its duration table:
"Micro-interactions · 100-150ms · Button hover, **checkbox toggle**". `Switch` — its sibling
control, same settings rows — animates both track colour and thumb position
(`switch.tsx:8,11`). A checkbox that snaps beside a switch that glides is an inconsistency a user
feels without naming.

**Recommendation.** Add `transition-[color,background-color,box-shadow] duration-100` to the root
and replace `transition-none` on the indicator with
`motion-safe:transition-transform motion-safe:duration-100
data-[state=unchecked]:scale-75 data-[state=checked]:scale-100`. The end state still reads
statically under reduced motion, which is the standard the grammar sets
(`design-system.md:609`).

---

### [P3/S] The two ground-truth docs give opposite instructions on reduced motion for `motion/react`

**Files:** `contributing/animations.md:621-635` and `:765-767` versus
`contributing/design-system.md:609`

**Current state.**
`animations.md` says: "Reduced motion is handled globally — no per-component work required …
**No per-component `useReducedMotion` calls are needed** unless you need to gate non-animation
behavior."
`design-system.md:609` says: "The one thing the reset does not reach is `motion/react`, which
writes inline styles from JS: **any `motion.*` component must call `useReducedMotion()` and
branch off**, not shorter."
The codebase splits accordingly: ~60 files call `useReducedMotion`, ~150 rely on
`MotionConfig reducedMotion="user"` alone.

**Why it falls short.** Both are half-right, and the half nobody wrote down is the one that
matters: `MotionConfig reducedMotion="user"` suppresses **transform and layout** animations but
not **opacity or colour**. So an infinite opacity or colour loop written in `motion/react` keeps
running under `prefers-reduced-motion` no matter what the global config says. The app currently
gets this right by convention (`use-session-border-state.ts:147-168` gates the infinite
`borderLeftColor` pulse; `LaneContent.tsx:503-505` gates its infinite sweep) — but an author
following `animations.md` literally would not.

**Recommendation.** Reconcile the two docs into one sentence with the actual mechanism:
_transform/layout animations are handled by `MotionConfig`; **opacity, colour and any `repeat:
Infinity` animation need an explicit `useReducedMotion()` gate**, and the gate belongs in a pure
function that also reports itself as a `data-` attribute_ (the `shouldAnimateRoster()` shape,
`design-system.md:624`). Doc-only change; no code moves.

---

### [P3/S] `usePulseMotion` exports an ungated infinite animation from an entity barrel

**Files:** `apps/client/src/layers/entities/session/model/use-pulse-motion.ts:20-25`,
exported at `entities/session/index.ts:127`;
correct callers `use-session-border-state.ts:157,166` (`pulse: !shouldReduceMotion`),
consumed by `SessionRowCompact.tsx:46` and `SessionRowFull.tsx:292`

**Current state.** The hook returns
`{ [property]: [color, dimColor, color] }` with `{ duration: 2, repeat: Infinity }` whenever its
`pulse` argument is true. It performs no reduced-motion check of its own; safety depends
entirely on every caller remembering to pass `!shouldReduceMotion`. Today both callers route
through `useSessionBorderState`, which does. The hook is nonetheless public API on the entity
barrel.

**Why it falls short.** It animates a **colour**, which `MotionConfig reducedMotion="user"` does
not suppress (see the finding above) — so a caller that forgets the gate ships a border pulsing
forever for a reader who asked for no motion, and nothing in typecheck, lint or jsdom would
report it (`design-system.md:624`: "no motion prop is assertable in jsdom, ever").

**Recommendation.** Move the gate inside the hook — call `useReducedMotion()` there and return
`{ animate: undefined, transition: undefined }` when it is true — so the barrel cannot hand out
an ungated infinite animation. Keep the `pulse` argument for the state logic. Following the
prescribed shape, have the consuming rows stamp the resolved boolean as a `data-` attribute so
the behaviour is observable from a browser test.

---

## Delight-and-surprise shortlist (all P3, all inside Calm Tech)

These are additive rather than corrective, and each is deliberately small enough that a user
would notice the _absence_ of friction rather than the presence of animation. Ranked by
value-per-line.

1. **Copy confirmation crossfade** — `shared/ui/copy-button.tsx`. Filed as a finding above; the
   highest-frequency success moment in the product, currently silent.
2. **Segmented-control travelling thumb** — `shared/ui/segmented-control.tsx`. Filed above. The
   Trust Dial's three stops are a spectrum; a thumb that _moves along it_ says that, a crossfade
   does not.
3. **Sidebar unread-count roll** — `features/dashboard-sidebar/ui/SidebarModelRow.tsx` badges and
   `widgets/inbox-bell/ui/InboxBellPill.tsx`. The message layer already ships a mechanical
   count roll (`@utility animate-count-flip`, `index.css:1117-1121`, 220ms, keyed on the number)
   and the chat chips ship `TickingNumber.tsx`. Nav badges snap. Reuse `animate-count-flip`
   rather than inventing a third counter; it is one class plus a `key={count}`.
4. **Empty-state settle on the first row** — `features/agents-list/ui/AgentEmptyFilterState.tsx`
   and `features/inbox/ui/InboxList.tsx:145`. When a list goes from empty to one item, the empty
   line vanishes and the row appears in the same frame. An `AnimatePresence mode="wait"` between
   the two — 120ms out, 120ms in — makes "your first agent arrived" feel like an event without
   spending anything. The room surface already has the vocabulary
   (`widgets/home/ui/QuietStateLine.tsx`).
5. **Skeleton → content crossfade** — `shared/ui/skeleton.tsx` consumers. Skeletons breathe with
   `animate-tasks` and then are replaced instantly by real content. A 100ms opacity handoff on
   the container (not per row) removes the flicker at the moment a page finishes loading, which
   is the single most-repeated transition in the app.
6. **Composer send settle** — `features/composer/ui/InputActionButton.tsx`. Once the 1.1 hover
   grow is removed (finding above), the button has budget for something better: a 120ms
   opacity+scale handoff between the send glyph and the stop square, so starting and stopping a
   turn read as one control changing state rather than two controls swapping places. The
   `AnimatePresence` is already there (`:260`); only the shared key and the exit are missing.

Not recommended, explicitly: page-level slide transitions, parallax, spring-loaded lists,
success confetti, anything with overshoot outside the two sanctioned moments
(`design-system.md:575`). The product is a control panel.
