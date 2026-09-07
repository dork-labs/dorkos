[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 18 — Motion: back inside the timing system

**Priority P2 · 14 findings · 11S · 3M**
**Scope:** the app chrome, which never got the attention the chat surfaces did. Most of these **remove or retime** motion rather than add it; two delete code outright. Batch 5 covers the missing-feedback half of this lens.

### 18.1 — The Sheet opens over half a second while its own scrim finishes in 150ms

**P2 · S · lens 10**
`apps/client/src/layers/shared/ui/sheet.tsx:61` (content), `:36` (overlay); consumers riding the default: `marketplace/ui/PackageDetailSheet.tsx:406`, `canvas/ui/AgentCanvas.tsx:218`, `dashboard-attention/ui/{FailedRunDetailSheet.tsx:65,OfflineAgentDetailSheet.tsx:80}`, `relay/ui/{SetupGuideSheet.tsx:33,MessagingConnections.tsx:328}`, `right-panel/ui/RightPanelContainer.tsx:209` (the whole mobile and Obsidian right panel)

**Evidence.** Verified in source: `SheetContent` ships `transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500`, while `SheetOverlay` sets `fade-in-0` with **no duration**, taking tw-animate's 150ms default. Opening any sheet: the scrim is fully black at 150ms and the panel is still sliding for another 350ms. 500ms is 200ms past the design system's own ceiling — its timing table tops out at "Slow · 300ms · Expand/collapse, overlays", and `animations.md:778` sets "Drawer/overlay slide · 200ms". `ease-in-out` on an entrance also contradicts the easing table, which reserves ease-out for entrances. Exactly one call site retimes it: `ProfileSheet` overrides to 300ms on its own className, and `design-system.md:619` records that as deliberate — _"Changing `sheet.tsx` would have re-timed Settings' panels too — a decision about every sheet in the app, which this was not."_ The doc parked this as a decision nobody had made. This audit is where it gets made.

**Recommendation.** Retime the primitive to `data-[state=open]:duration-200 data-[state=closed]:duration-150`, swap `ease-in-out` for the ease-out curve on open, and give `SheetOverlay` a matching duration so scrim and panel land together. Then delete `ProfileSheet`'s override, which exists only to escape the default.

### 18.2 — The send button and top-bar chrome grow 10% on hover — the loudest motion in the app

**P2 · S · lens 10**
`apps/client/src/layers/features/composer/ui/InputActionButton.tsx:267,321`, `features/right-panel/ui/RightPanelToggle.tsx:62`, `features/top-nav/ui/CommandPaletteTrigger.tsx:23`

**Evidence.** Four always-visible chrome controls carry `whileHover={{ scale: 1.1 }}`, and the two composer buttons pair it with `whileTap={{ scale: 0.9 }}`. `design-system.md:206` specifies the send button by name: "Subtle scale pulse on hover (**1.05**), quick press feedback" — the shipped value is double that. `whileTap` 0.9 is a 10% squash against a documented 0.97 press and against the identity grammar's ladder, whose most aggressive stop is 0.94 for a mark used as a button. A control that jumps 10% under the cursor is the Calm Tech anti-pattern "Dramatic animations" sitting on the two surfaces a pointer visits most.

**Recommendation.** Bring all four to `whileHover={{ scale: 1.05 }}` / `whileTap={{ scale: 0.97 }}` — or, better for the two icon-only top-bar controls, drop the hover scale entirely and let the existing `hover:bg-accent` tint do the work, which is what the rest of the app's chrome does. Keep the press. (`AvatarPickerGrid.tsx:346`'s `whileHover 1.25` is deliberately exempt — the avatar picker is one of the two sanctioned overshoot moments.)

### 18.3 — Two shipped overlays declare exit animations that can never run

**P2 · S · lens 10**
`apps/client/src/layers/features/jump-back-in/ui/JumpBackInPopover.tsx:242-245` + call site `widgets/room-view/ui/ChannelComposer.tsx:418`; `apps/client/src/layers/entities/discovery/ui/CandidateCard.tsx:64-69` + call site `features/onboarding/ui/ConversationDiscoveryBeat.tsx:159-168`

**Evidence.** `JumpBackInPopover` has `initial`/`animate` and **no `exit` at all**, and its call site renders it as a bare `{jumpBackIn.isOpen && (…)}` with no `AnimatePresence` — so it fades in over 150ms and vanishes in a single frame. Eleven lines above it in the _same file_, `MentionPalette` — a panel of the same size in the same slot — is correctly wrapped and animates both ways. `CandidateCard` declares `exit={{ opacity: 0, y: -6 }}`; on `/connections` its parent wraps the list in `<AnimatePresence mode="popLayout">` (`DiscoveryView.tsx:354`) and the exit plays, but in onboarding the same component is mapped with no `AnimatePresence`, so approving a project makes the card disappear instantly and the ones below jump up. `animations.md:562-578` names this exact failure, and the repo already knows the trap well enough to comment on it (`SessionComposer.tsx:635-639`). The onboarding case is the worse of the two: the first surface a new user touches got the abrupt treatment while the settings page got the polished one.

**Recommendation.** Give `JumpBackInPopover` the same `exit={{ opacity: 0, scale: 0.98, y: 4 }}` its three sibling palettes already use with identical values (`MentionPalette.tsx:51`, `CommandPalette.tsx:47`, `FilePalette.tsx:48`) and wrap the call site in `AnimatePresence`. Wrap the onboarding candidate map in `<AnimatePresence mode="popLayout">`, matching `DiscoveryView`. Both are two-line changes.

### 18.4 — The three largest moving surfaces all ease-in-out an entrance

**P2 · M · lens 10**
`apps/client/src/layers/shared/ui/sidebar.tsx:217,228`, `features/right-panel/ui/RightPanelContainer.tsx:21,23`, `shared/ui/sheet.tsx:61`, `shared/ui/identity-avatar.tsx:108`

**Evidence.** `ease-in-out` appears in exactly six client files, four of them the app's biggest moving chrome: `transition-[width] duration-300 ease-in-out` and `transition-[left,right,width] duration-300 ease-in-out` on the sidebar, `'flex-grow 300ms ease-in-out'` and `'opacity 300ms ease-in-out'` on the right panel. Everything else uses `ease-out` (14 uses) or a spring. The easing table is unambiguous: `ease-out cubic-bezier(0, 0, 0.2, 1)` for "Entrances (fast start, gentle stop)", `ease-in` for exits. `ease-in-out` starts slowly, which is why the sidebar and right panel feel like they hesitate before moving. The sidebar is also 300ms against a documented 200ms ("Sidebar toggle: Width transition 200ms"), so it is out of spec on both axes.

**Recommendation.** One pass across those four files: entrances to `ease-[cubic-bezier(0,0,0.2,1)]`, exits to `ease-[cubic-bezier(0.4,0,1,1)]`, and bring the sidebar width to 200ms. Effort is M rather than S only because the sidebar and right panel both have browser tests measuring their settled geometry, which should be re-run.

### 18.5 — The Inbox staggers an uncapped list, so a busy inbox appears to load slowly

**P2 · S · lens 10**
`apps/client/src/layers/features/inbox/ui/InboxList.tsx:30,150`, `features/inbox/ui/InboxRow.tsx:14-15`

**Evidence.** `staggerContainer` sets `staggerChildren: 0.03` and the container wraps `items.map(...)` with no slice and no per-index cap; `InboxRow` declares `initial: { opacity: 0, y: 6 }` as its child half. Thirty notifications means the last row waits 900ms; sixty means 1.8s. `animations.md:327` states the rule — "Limit stagger to the first 8 visible items — items beyond index 7 render immediately without animation to avoid excessive delay" — and the rest of the app obeys it: `TasksList.tsx:21,140` caps at 8, `PackageGrid.tsx:19,152` caps at 20, `PulseAttentionSection.tsx:56-58` and `ApprovalList.tsx:45` cap by slicing. Inbox is the one uncapped list, and the one most likely to be long. It reads as latency, not as motion.

**Recommendation.** Adopt the `TasksList` shape exactly: pass `index` down and give `variants={index < 8 ? staggerItem : undefined}`. (Separately noted for lens 9: `InboxList.tsx:132-134` renders a bare `"Loading…"` string replaced by a staggered list in one frame — the two states should share a shape.)

### 18.6 — Dead motion CSS: three keyframe blocks with no consumer anywhere

**P3 · S · lens 10**
`apps/client/src/index.css:797-815` (`@keyframes breathe` + `.dorkbot-avatar` + `.dorkbot-avatar.reacting`), `:817-827` (`@keyframes shimmer-pulse`), `:1169-1180` (`@keyframes health-pulse` + `.animate-health-pulse`)

**Evidence.** Verified by grepping the whole client: `shimmer-pulse`, `.dorkbot-avatar` and `.animate-health-pulse` appear only in `index.css` itself and match no element in any component. `health-pulse` also hardcodes `rgb(16 185 129 / 0.4)` — the emerald of the mesh-health ring that `design-system.md:555` records as removed ("That ring is gone (DOR-1052) — health is drawn where health is the subject"). This is its leftover. AGENTS.md §Quality Standard: "no dead code, no tolerated legacy patterns." Live CSS that animates nothing is also a trap: the next author greps `health-pulse`, finds a ready-made pulse utility, and reintroduces a signal the design system deliberately deleted.

**Recommendation.** Delete all three blocks (~40 lines). If the DorkBot breathe is wanted again it should come back as `animate-tasks` (renamed `animate-breath` per 15.14), which is the app's one documented "work is happening" breath.

### 18.7 — `transition-all` in 26 places, against a rule the codebase states out loud

**P3 · S · lens 10**
`shared/ui/button.tsx:8`, `tabs.tsx:33`, `progress.tsx:28`, `input-otp.tsx:45`, `option-row.tsx:27`, `compact-result-row.tsx:24`, `responsive-dialog.tsx:125`, `route-error-fallback.tsx:68`, `link-safety-modal.tsx:74`, `sidebar.tsx:288`, `index.css:549`, plus 15 feature files (`chat/ui/tasks/{TaskProgressHeader.tsx:34,InlineKillButton.tsx:75,AgentRunner.tsx:266,BackgroundTaskBar.tsx:224}`, `chat/ui/message/FileAttachmentList.tsx:70`, `chat/ui/primitives/{CompactPendingRow.tsx:27,CollapsibleCard.tsx:52}`, `ask/ui/AskCard.tsx:184`, `marketplace/ui/PackageCard.tsx:112`, `agent-creation/ui/GalleryCard.tsx:58`)

**Evidence.** `transition-all` transitions every animatable property, layout ones included. On `Button` it is doubly wrong: `RESPONSIVE_SIZE_CLASSES` changes `height` at the `md:` breakpoint, so dragging a window across 768px animates the height of every button on screen. The house rule is already written in the codebase, by the component that got the most motion attention — `TeamMemberCard.tsx:225`: "…rather than `transition-all`, so what moves stays auditable" — and `animations.md:580-600` lists animating layout properties as an explicit anti-pattern.

**Recommendation.** Replace each with an explicit property list. The overwhelmingly common correct answer is `transition-[color,background-color,border-color,box-shadow]`, adding `transform` where a press or lift is involved. Low risk, mechanical, and it makes the diff of any future motion change readable.

### 18.8 — `IdentityAvatar`'s disc crossfades its colour over 500ms — a fourth speed in a three-speed system

**P3 · S · lens 10**
`apps/client/src/layers/shared/ui/identity-avatar.tsx:108`

**Evidence.** The base cva string is `'relative inline-flex shrink-0 items-center justify-center transition-[background-color] duration-500 ease-in-out'`. A Mark-tier disc later merges `duration-(--identity-answer)` (120ms) from `identityMarkRing` and tailwind-merge lets that win — but every _non-Mark_ disc, which is the large majority (feed avatars, roster faces, message authors, mention-pill discs), keeps the 500ms `ease-in-out`. The section immediately below states the constraint in its own heading: "**Three speeds and two curves, in `index.css`. There is no fourth.**" — 80ms press, 120ms answer, 200ms settle. 500ms is more than double the slowest, and `ease-in-out` is not one of the two curves. It is also the only place in the client where a colour change on a _non-interactive_ element is animated, which `design-system.md:226` lists under "What NOT to Animate".

**Recommendation.** Change the base to `transition-[background-color] duration-(--identity-settle) ease-(--identity-ease-standard)`, or drop the base transition entirely and let only the Mark-tier class carry one. Either way the disc stops being the exception to its own section.

### 18.9 — Dropdown menus zoom from their own middle; every other overlay grows out of its trigger

**P3 · S · lens 10**
`apps/client/src/layers/shared/ui/dropdown-menu.tsx:19-25` (`DropdownMenuContent`); compare `:132-139` (`DropdownMenuSubContent`, correct), `popover.tsx:30`, `select.tsx:45`, `hover-card.tsx:42`, `context-menu.tsx:67`, `tooltip.tsx:43`

**Evidence.** `DropdownMenuContent` sets `zoom-in-95` with no `origin-(--radix-dropdown-menu-content-transform-origin)`, so it scales from its geometric centre, and its slide list covers only `data-[side=bottom]` and `data-[side=top]` — a dropdown Radix flips to `side="left"` or `"right"` near a viewport edge gets no directional slide at all. Its own `SubContent`, twelve lines further down, has all four sides. Popover, select, hover-card, context-menu and tooltip all set the origin variable and all four sides. The transform origin is what makes an overlay read as _coming from the thing you clicked_, and dropdowns are the most-opened overlay in this app — every kebab, every `NewMenu`, every row menu.

**Recommendation.** Add `origin-(--radix-dropdown-menu-content-transform-origin)` and the two missing side rules, making `DropdownMenuContent` identical in motion to `PopoverContent`. One line changed, one added.

### 18.10 — Three tab controls, three unrelated motion answers

**P3 · M · lens 10**
`apps/client/src/layers/shared/ui/tabs.tsx:33,44-57` (trigger crossfades via `transition-all`; `TabsContent` has **no** enter animation), `shared/ui/segmented-control.tsx:70` (crossfade only), `shared/ui/bar-tab-strip.tsx:229` (`layoutId` sliding underline, spring)

**Evidence.** The app ships three ways to pick one of N side-by-side options, each answering differently: the One Bar slides an indicator, the segmented control (the Trust Dial's three stops) crossfades a raised thumb in place, and the shadcn Tabs primitive crossfades a trigger and swaps its panel with zero transition. These sit within one screen of each other — Settings dialog, Trust Dial, Home bar — so a user learns "selection slides here, snaps there" for no reason they can name, which is the opposite of "inevitable design". The codebase already owns the good answer twice (`bar-tab-strip.tsx:229`, `navigation-layout.tsx:361`).

**Recommendation.** Give `SegmentedControlItem` the `layoutId` thumb — a `motion.div` with `layoutId` behind the checked segment, `LayoutGroup`-scoped, spring 280/32, the same preset the nav pill uses — so the raised surface _travels_ between stops instead of blinking across. That matters most on the Trust Dial, whose three stops are a spectrum. Give `TabsContent` an enter-only fade (`data-[state=active]:animate-in fade-in-0 duration-150`); no exit, so no two-panels-mounted problem. Leave `BarTabStrip` alone — it is the reference.

### 18.11 — Route content hard-cuts while the chrome describing it cross-fades

**P3 · M · lens 10**
`apps/client/src/AppShell.tsx:783` (`<Outlet />`); compare `:602-624` (sidebar body directional slide, 200ms) and `:711-736` (header content crossfade, 100ms)

**Evidence.** `AppShell`'s own doc comment says it: "The sidebar body directional-slides (200ms) and header content cross-fades on route change via AnimatePresence" (`:215-217`). The `<Outlet />` inside `<Panel id="main-content">` has nothing. Navigating Home → Team → Marketplace slides the sidebar, fades the header, and replaces the entire page body in a single frame — the chrome moves and the content it describes does not, which reads as the page failing to keep up with its own navigation. `design-system.md:210` already establishes in-page transitions as part of the language, and `animations.md:775` gives them a duration-table row.

**Recommendation.** Wrap the outlet in `<AnimatePresence mode="wait" initial={false}>` with a `motion.div key={pathname}` doing **opacity only** — `{ duration: 0.12, ease: 'easeOut' }`, no translate. Opacity-only is the safe form: the routed page owns its own scroller, and a transform on the wrapper would create a containing block that breaks the `fixed` PIP layer and the panel-group measurement. Effort M because it needs a browser check against the right panel, the PIP dock and scroll restoration, not because the change is large.

### 18.12 — A shared primitive hardcodes a global `layoutId`

**P3 · S · lens 10**
`apps/client/src/layers/shared/ui/navigation-layout.tsx:361` (`layoutId="nav-layout-active-pill"`, inside the `LayoutGroup` at `:141-148`), consumer `shared/ui/tabbed-dialog.tsx:177`; compare `shared/ui/bar-tab-strip.tsx:41` (`indicatorLayoutId: string` — a _required prop_)

**Evidence.** `NavigationLayout` — the chassis under `TabbedDialog` and therefore under Settings — burns a fixed string into a `shared/ui` primitive. The surrounding `<LayoutGroup>` carries no `id`, so it groups measurement but does not namespace the id: two `NavigationLayout` instances mounted at once would share one pill and teleport it between them. `BarTabStrip`, built later, made the id a required prop precisely to avoid this. `animations.md:272` gives the rule ("Wrap the list in `<LayoutGroup>` to scope the `layoutId` and prevent conflicts"). The failure is latent today because `DialogHost` opens one dialog at a time — but the primitive is exported for anyone.

**Recommendation.** Follow `BarTabStrip`: take the id as a prop defaulting to a `React.useId()` value, and/or pass it to `<LayoutGroup id={…}>`. Worth the same treatment for `layoutId="active-session-bg"` (`SessionRowFull.tsx:115`) and `layoutId="cmd-palette-selection"` (`AgentCommandItem.tsx:57`), both currently safe by single-instance convention rather than by construction.

### 18.13 — The copy button's confirmation is a hard cut — the cheapest delight in the app, unspent

**P3 · S · lens 10**
`apps/client/src/layers/shared/ui/copy-button.tsx:32-34,49-50`

**Evidence.** `CopyButtonIcon` returns one of three lucide icons with no transition of any kind (`if (copied) return <Check … />`), and the button's className carries only `transition-colors`. Copy → check → copy back is three instantaneous swaps. This is the archetypal "did it work?" micro-interaction, appearing on every code block, path breadcrumb, id and memory row — and it is the one moment in the app where a tiny piece of motion would be _carrying information_ (the action succeeded) rather than decorating, which is exactly what the design language says motion is for.

**Recommendation.** Wrap the icon in `AnimatePresence mode="wait"` keyed on the state, with `initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.12 }}`. Under `MotionConfig reducedMotion="user"` the scale drops and the crossfade remains, which still reads. (Also: `text-green-500` at `:32` is a raw palette colour where `text-status-success` exists — fold into 4.4.)

### 18.14 — `usePulseMotion` exports an ungated infinite animation from an entity barrel

**P3 · S · lens 10**
`apps/client/src/layers/entities/session/model/use-pulse-motion.ts:20-25`, exported at `entities/session/index.ts:127`; correct callers `use-session-border-state.ts:157,166`; consumed by `SessionRowCompact.tsx:46`, `SessionRowFull.tsx:292`

**Evidence.** The hook returns `{ [property]: [color, dimColor, color] }` with `{ duration: 2, repeat: Infinity }` whenever its `pulse` argument is true, and performs no reduced-motion check of its own — safety depends entirely on every caller passing `!shouldReduceMotion`. Today both callers route through `useSessionBorderState`, which does. But it animates a **colour**, which `MotionConfig reducedMotion="user"` does not suppress (see 16.7), so a caller that forgets the gate ships a border pulsing forever for a reader who asked for no motion — and nothing in typecheck, lint or jsdom would report it (`design-system.md:624`: "no motion prop is assertable in jsdom, ever"). The hook is public API on the entity barrel.

**Recommendation.** Move the gate inside the hook: call `useReducedMotion()` there and return `{ animate: undefined, transition: undefined }` when true, so the barrel cannot hand out an ungated infinite animation. Keep the `pulse` argument for the state logic. Following the prescribed shape, have the consuming rows stamp the resolved boolean as a `data-` attribute so the behaviour is observable from a browser test.
