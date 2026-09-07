[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 7 — Touch targets and hover-only affordances

**Priority P1 · 8 findings · 4S · 4M**
**Scope:** controls that are too small for a thumb, or that hide their only information behind `:hover` on a device with no hover. One PR per cluster is reasonable; 7.5 touches a shared primitive family.

### 7.1 — Composer queue actions are 24px targets, three adjacent, one destructive

**P1 · S · lens 8**
`apps/client/src/layers/features/chat/ui/input/QueuePanel.tsx:133-163`

**Evidence.** Verified in source: the queued-message row draws up to three buttons — move up, send now, remove — each `flex size-6 shrink-0` (24×24px) around a `size-3` glyph. The _visibility_ half of the mobile pattern is correct (`opacity-100 … md:opacity-0 md:group-hover:opacity-100`, so they are always visible below `md`). The _size_ half is absent: none picks up `TOUCH_TARGET_MIN_H` or any `md:`-gated bump. This is the composer — the highest-frequency surface in the app, on every session including phone — with "send now" and "remove" side by side at 24px and no size difference between the constructive and destructive action. A mistap silently discards a queued message.

**Recommendation.** Grow the hit area without changing the glyph, the way `SidebarGroupAction` already does: `after:absolute after:-inset-3 md:after:hidden`. Desktop density is unchanged; the tap target reaches 44px below `md`.

### 7.2 — Terminal and Canvas tab strips ship zero mobile adaptation, inside the mobile right-panel Sheet

**P2 · M · lens 8**
`apps/client/src/layers/features/terminal/ui/TerminalTabs.tsx:85-124`, `apps/client/src/layers/features/canvas/ui/CanvasHeader.tsx:100-140`; reachability via `apps/client/src/app/init-extensions.ts:274-301` and `RightPanelContainer.tsx:205-226`

**Evidence.** Both draw the same pattern: a `role="tab"` button plus an absolutely-positioned close button, `p-0.5` around a `size-3` `X` — roughly 16×16px — with `tabIndex={-1}` and `opacity-60`. Neither file imports `useIsMobile`, checks a `md:` breakpoint, or applies `TOUCH_TARGET_MIN_H`. Mobile reachability was traced, not assumed: both panels are registered right-panel contributions, and `RightPanelContainer` falls back to a full-width `ResponsiveSheet` on mobile-width viewports, so both strips render at native size on a phone. (The sibling `AppTabItem`/`AppTabBar` strip was checked and correctly excluded — it is gated behind `isDesktopShell()`.)

**Recommendation.** Give the close button — and the `role="tab"` button's own sub-44px `py-1` height — the same `md:`-gated touch growth the composer and sidebar rows use.

### 7.3 — Background-task hover tooltips have no touch equivalent

**P2 · M · lens 8**
`apps/client/src/layers/features/chat/ui/tasks/BackgroundTaskBar.tsx:209-239`, `apps/client/src/layers/features/chat/ui/tasks/AgentRunner.tsx:261-284`

**Evidence.** Both render a CSS-only tooltip revealed solely by `group-hover`, with no `md:` gate and no `useIsMobile` branch. The bar renders unconditionally above every session's composer (`SessionComposer.tsx:662`), mobile included. On touch `:hover` never fires, so the only information these controls carry — what a running subagent is doing, how long it has run, and which subagents hide behind the "+N" badge — is structurally unreachable. This is the exact class `design-system.md`'s "Hover Pattern Mobile Alternatives" table exists to prevent, and sibling components in the same tree (`QueuePanel`, `WidgetFence`, `InlineTextField`, `SessionRowFull`) already follow it.

**Recommendation.** Swap the CSS-only box for the existing `Tooltip` primitive (which has a documented use for exactly this), or gate it `md:group-hover:opacity-100` and render it always-visible-but-quieter below `md`, matching the siblings.

### 7.4 — Schedule builder opts out of touch scaling inside a dialog that becomes a full-screen mobile drawer

**P2 · M · lens 8**
`apps/client/src/layers/features/tasks/ui/TaskBuilder.tsx:374-478`; shell at `layers/features/tasks/ui/CreateTaskDialog.tsx:14-20`

**Evidence.** `CreateTaskDialog` correctly uses `ResponsiveDialog`, so on a phone the form becomes a full-screen `Drawer` — the right shell decision. Every `Select` inside then opts back out: `<SelectTrigger responsive={false} className="h-9">` (frequency), `responsive={false} className="h-9 w-32"` (time), `responsive={false} className="h-9 w-20"` (day of month). The weekly day-of-week pills are hand-rolled at `px-2.5 py-1 text-xs` with no touch consideration and no `responsive` prop to opt into. Unlike `button.tsx`'s deliberately-excluded `xs` sizes, which carry a comment explaining they are intentionally small chrome, nothing documents why this form should stay at 36px/28px desktop density inside a surface the product already decided needs full-screen mobile treatment.

**Recommendation.** Drop the three `responsive={false}` overrides and give the day-of-week toggles the same `min-h-11`/inset treatment `SidebarGroupAction` uses.

### 7.5 — `FilterBar` blanket-disables touch scaling across `/tasks`, `/team` and `/activity`

**P2 · M · lens 8**
`apps/client/src/layers/shared/ui/filter-bar/FilterBarSearch.tsx:20-26`, `FilterBarAddFilter.tsx:172,205,246,262`, `FilterBarActiveFilters.tsx:101,112`, `FilterBarResultCount.tsx:27`

**Evidence.** Every `Button`/`Input`/`Select` this shared control surface renders is explicitly passed `responsive={false}` — e.g. `<Input responsive={false} … className="h-8 pl-8 text-sm sm:max-w-64" />`. `FilterBar` backs the toolbars on `TasksList` (`/tasks`), `AgentsList` (`/team`) and `ActivityFilterBar` (`/activity`), all real routes with no mobile redirect. The whole point of the `responsive` prop, per `button.tsx:44-59`'s own comment, is to give exactly this class of dense control extra headroom below `md`; `FilterBar` forecloses it everywhere it is used.

**Recommendation.** Drop `responsive={false}` from the FilterBar primitives. If the dense desktop row height must be preserved, use the pattern `RESPONSIVE_SIZE_CLASSES` demonstrates — a `md:`-scoped desktop override — rather than disabling scaling outright.

### 7.6 — Height overrides without `responsive={false}` render _smaller_ on phone than on desktop

**P2 · S · lens 8**
`apps/client/src/layers/features/relay/ui/AdapterEventLog.tsx:101`, `apps/client/src/layers/features/extensions/ui/SettingFieldRenderers.tsx:247`, `apps/client/src/layers/features/relay/ui/ConversationRow.tsx:248`

**Evidence.** All three pass a raw height to `SelectTrigger` without `responsive={false}`. `SelectTrigger`'s default is `responsive ? 'h-11 md:h-9' : 'h-9'`, and `cn()`'s tailwind-merge resolves conflicts per (modifier-set, class-group) pair: the caller's unprefixed `h-7`/`h-8` wins against the unprefixed `h-11`, but `md:h-9` carries a different modifier set and survives. The rendered list is `h-7 … md:h-9` — below `md` only the bare `h-7` matches (28px); at `md` and above `md:h-9` (36px) wins the cascade. The net is backwards from the system's intent: these render smaller on a phone than on desktop.

**Recommendation.** Pass `responsive={false}` (matching `TaskRunHistoryPanel.tsx:445`, which does this correctly) or drop the custom height. Worth a broader sweep: a grep for `<Button`/`<SelectTrigger` with an explicit `h-` className and no `responsive` prop turned up ~12 further candidates (`IntegrationBindingCard.tsx:208`, `ManifestSettingsPanel.tsx:362`, `PermissionPrimer.tsx:110,113`) not individually traced for mobile reachability.

### 7.7 — Activity filter chips are 24px inside a scrollable strip

**P3 · S · lens 8**
`apps/client/src/layers/features/activity-feed-page/ui/ActivityFilterBar.tsx:32,59`

**Evidence.** At 390×844 the "All / Schedules / Relay / Agent / Config / System" row renders each chip at `h-6` (24px) inside an `overflow-x-auto` strip. 24px is well under the ~44px guidance, compounded by living in a row a thumb might scroll instead of tap. Downgraded to P3 because `design-system.md` documents `xs` at 24px as an accepted token and the row scrolls rather than clips — but a filter chip a phone user taps repeatedly, inside a scrollable row, is a harder case than a desktop-density button.

**Recommendation.** Keep the compact visual chip and grow the tap target independently: wrap in a `min-h-11` pressable area with the visible `h-6` pill centred inside, the "small visual, larger hit box" pattern already used for icon buttons.

### 7.8 — The right-panel mobile Sheet is always full-height regardless of content

**P2 · S · lens 8**
`apps/client/src/layers/features/right-panel/ui/RightPanelContainer.tsx:202-226`, `apps/client/src/layers/shared/ui/responsive-sheet.tsx:24-58`

**Evidence.** At 390×844 with the panel open, Pulse's content ends around y=250 and the sheet fills to 844 (~590px of dead space); the Files tab's six folder rows end around y=240 with the same ~600px empty. `ResponsiveSheetContent` always sets `side="right"` and widens to `w-full` on mobile — a right-edge slide-over stretched to fill the screen, not a sheet sized to its content — with no cue that there is nothing below and no swipe-to-dismiss (the user must find the small "Close panel" X).

**Recommendation.** Charter adaptive strategy (d). A full-screen right-edge overlay is right for panels with substantial content (Terminal, Canvas); for short-content panels a bottom sheet sized to content, with a drag handle, swipe-to-dismiss and a max-height scroll, reads as intentional. If one presentation must be kept, at minimum cap the sheet's height to its content on mobile.
