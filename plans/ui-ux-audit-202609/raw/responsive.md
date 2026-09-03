# Responsiveness — Lens 8 Findings

Auditor scope: `apps/client/src` — mobile/tablet/desktop behavior, touch targets, hover-only
affordances without touch fallback, missing breakpoint handling, dialogs/popovers not adapting
to drawer/sheet on mobile.

## Coverage

**Read first (ground truth):**

- `contributing/design-system.md` in full, including the "Mobile Responsive Scale" section
  (the `--mobile-scale` / `--_st` / `--_si` / `--_sb` CSS-multiplier system), "Hover Pattern
  Mobile Alternatives", "Responsive Components" (`ResponsiveDialog`/`ResponsivePopover`/
  `ResponsiveDropdownMenu`), and "Data Tables" (`meta.hideOnMobile`).
- `contributing/animations.md`, `.claude/rules/fsd-layers.md` (context, no responsiveness content).
- `apps/client/src/index.css` — the actual `--_st`/`--_si`/`--mobile-scale` token definitions,
  to confirm what the design doc's scale claims compile to.
- `apps/client/src/layers/shared/ui/touch-target.ts` (`TOUCH_TARGET_MIN_H`), `button.tsx`,
  `input.tsx`, `select.tsx` (the shared `responsive` prop mechanics all three share).
- The shipped reference implementations: `layers/widgets/mobile-tabs/**` (the phone-only bottom
  bar and panel host), `layers/shared/ui/responsive-dialog.tsx`, `responsive-popover.tsx`,
  `responsive-dropdown-menu.tsx`, `responsive-sheet.tsx`, `layers/features/right-panel/ui/
RightPanelContainer.tsx` (desktop split-pane vs. mobile full-width `Sheet`), `layers/shared/ui/
tabbed-dialog.tsx` + `navigation-layout.tsx` (the drill-in pattern `SettingsDialog` uses).

**Method:** started from the two documented mobile mechanisms (the CSS scale-multiplier system
and the `Responsive*` wrapper family), then grepped the whole `apps/client/src/layers` tree for
the patterns the brief calls out — `opacity-0`/`group-hover` reveals, hardcoded `h-`/`size-`
overrides on `Button`/`Select`/`Input`, `responsive={false}` call sites, raw `text-[Npx]`/
`size-[Npx]` arbitrary values that bypass the token scale, plain `Dialog`/`Popover` usage next to
the `Responsive*` equivalents, and fixed pixel widths. Every component flagged below was traced
to a real, currently-mobile-reachable route or panel (confirmed via `AppShell.tsx`,
`RightPanelContainer.tsx`, `router.tsx`, and the feature's own render tree) before being reported
— several initial hits (the Electron-only `AppTabBar`/`AppTabItem` window-tab strip, gated behind
`isDesktopShell()`; `EntryReactionPicker`'s popover body, which is explicitly the shared content
for both a desktop popover and a touch long-press drawer) were traced and dropped once confirmed
desktop-only or already handled.

**Covered in depth:** `layers/shared/ui` (all ~90 files scanned for `responsive`/touch-target
patterns; primitives read in full: `button.tsx`, `input.tsx`, `select.tsx`, `dialog.tsx`,
`responsive-*.tsx`, `tabbed-dialog.tsx`, `navigation-layout.tsx`, `filter-bar/*`,
`touch-target.ts`); the chat composer stack (`features/chat/ui/input/*`, `features/chat/ui/
tasks/*`); the right-panel host and its two current tabs (`features/right-panel`, `features/
terminal`, `features/canvas`); `features/tasks` (schedule builder + history panel); the mobile
shell itself (`widgets/mobile-tabs`, `AppShell.tsx`).

**Sampled, not exhaustive:** the ~60 `features/*` and 17 `widgets/*` slices — grepped for the
specific patterns above across the whole tree (so a hit anywhere surfaces), but only a
representative subset of hits was traced end-to-end to confirm mobile-reachability and read for
full context. `dev/` playground pages were not audited (out of scope — they are desktop dev
tooling, not the shipped product surface). Icon-sizing token adoption (`size-[--size-icon-*]`
vs. raw `size-N`) was investigated but not reported as a scored finding: the token is used only
11 times against roughly 700 raw `size-N` occurrences, but a blunt count over that pattern
includes many non-icon uses (status dots, avatars, spacing), so the true defect rate could not be
established without tracing every hit individually, which the time budget did not allow. Native
gesture/viewport behavior (actual pinch-zoom, virtual-keyboard resize) was not tested in a real
browser — this is a static code-reading audit; a companion device-driven pass would strengthen
several findings below with screenshots.

---

### [P1/S] Composer queue actions are 24px targets, three adjacent, one destructive

**Files:** `apps/client/src/layers/features/chat/ui/input/QueuePanel.tsx:133-163`

The composer's queued-message row draws up to three action buttons per item — move up
(`onMoveUp`), send now (`onSend`), and remove (`onRemove`) — each `flex size-6 shrink-0 …`
(24×24px):

```tsx
<button type="button" onClick={() => onMoveUp(item.id)}
  className="… flex size-6 shrink-0 items-center justify-center rounded-sm opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 …">
  <ArrowUp className="size-3" />
</button>
…
<button type="button" onClick={() => onSend(item.id)} …
  className="… flex size-6 shrink-0 items-center justify-center rounded-sm transition-colors">
  <CornerDownLeft className="size-3" />
</button>
…
<button type="button" onClick={() => onRemove(item.id)} …
  className="… flex size-6 shrink-0 items-center justify-center rounded-sm opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 …">
  <X className="size-3" />
</button>
```

The visibility half of the mobile pattern is handled correctly (`md:opacity-0
md:group-hover:opacity-100` — always visible below the `md` breakpoint, exactly the pattern
`design-system.md`'s "Hover Pattern Mobile Alternatives" table documents). The **size** half is
not: none of the three buttons picks up `TOUCH_TARGET_MIN_H` (`shared/ui/touch-target.ts`,
`min-h-11` = 44px) or any `md:`-gated size bump the way `Button`/`Input`/`Select` do by default.
This is the composer — the highest-frequency surface in the whole app, present on every session,
mobile included (queue panel sits directly above the input) — and "send now" and "remove" sit
side by side at 24px with no size difference between the constructive and the destructive action.
A phone user queuing several messages while multitasking is exactly the scenario this panel
exists for, and a mistap here silently discards a queued message instead of sending it.

**Recommendation:** wrap each button's hit area the way `SidebarGroupAction` does elsewhere in
the app (`design-system.md` §Responsive Components: `after:absolute after:-inset-3 md:after:hidden`)
so the 24px glyph keeps its dense desktop footprint but the tap target grows to 44px below `md`,
or apply `TOUCH_TARGET_MIN_H` directly. Either keeps the visual chrome unchanged on desktop.

---

### [P2/M] Terminal and Canvas tab strips ship zero mobile touch adaptation, despite rendering inside the mobile right-panel Sheet

**Files:** `apps/client/src/layers/features/terminal/ui/TerminalTabs.tsx:85-124`,
`apps/client/src/layers/features/canvas/ui/CanvasHeader.tsx:100-140`

Both components draw an identical pattern: a `role="tab"` button plus a sibling absolutely-
positioned close button, `p-0.5` around a `size-3` (12px) `X` icon — roughly a 16×16px hit area —
with `tabIndex={-1}` and `opacity-60` (not `opacity-0`, so at least always visible, but never
resized):

```tsx
// TerminalTabs.tsx:103-111 (CanvasHeader.tsx:127-135 is the same shape)
<button
  type="button"
  tabIndex={-1}
  onClick={() => onClose(tab.key, 'pointer')}
  aria-label={`Close ${tab.label}`}
  className="focus-ring hover:bg-background/80 absolute top-1/2 right-1 -translate-y-1/2 rounded-sm p-0.5 opacity-60 transition-opacity group-hover:opacity-100"
>
  <X className="size-3" />
</button>
```

Neither file imports `useIsMobile`, checks a `md:` breakpoint, or applies `TOUCH_TARGET_MIN_H`.
This was traced to confirm mobile reachability rather than assumed from the file name: both
`TerminalPanel` and `AgentCanvas`/`CanvasHeader` are registered as `right-panel` contributions
(`apps/client/src/app/init-extensions.ts:274-301`), and `RightPanelContainer.tsx:205-226` falls
back to a full-width `ResponsiveSheet` "on mobile-width viewports in the routed shell" — so both
tab strips, close buttons included, render at native size inside that sheet on a phone. The
sibling `AppTabItem`/`AppTabBar` (a different, Electron-window-only tab strip gated by
`isDesktopShell()` in `AppShell.tsx:664`) was checked and correctly excluded from this finding —
it is genuinely desktop-only. `TerminalTabs`/`CanvasHeader` are not.

**Recommendation:** give the close button (and the `role="tab"` button's own `py-1` height, also
under 44px) the same `md:`-gated touch-target growth the composer and sidebar rows already use.

---

### [P2/M] Background-task hover tooltips have no touch equivalent

**Files:** `apps/client/src/layers/features/chat/ui/tasks/BackgroundTaskBar.tsx:209-239`,
`apps/client/src/layers/features/chat/ui/tasks/AgentRunner.tsx:261-284`

Both render a CSS-only tooltip (task description, tool-call count, elapsed duration; the overflow
badge's tooltip additionally lists every subagent beyond the visible cap) that is _only_ revealed
by `group-hover`, with no `md:` gate and no `useIsMobile` branch:

```tsx
// BackgroundTaskBar.tsx:220-228 — comment says "Hover tooltip", and it is the only path in
<div className={cn(
  'pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2',
  '-translate-x-1/2 translate-y-1 opacity-0 transition-all duration-150',
  'group-hover:translate-y-0 group-hover:opacity-100',
  …
)}>
```

This bar renders unconditionally above every session's composer (`SessionComposer.tsx:662`,
`aboveInput={<BackgroundTaskBar … />}`), mobile included. On a touch device `:hover` never fires,
so the only information this control carries — what a running subagent is actually doing, how
long it has run, and (for 3+ concurrent subagents) which ones are hidden behind the "+N" badge —
is structurally unreachable. This is exactly the class of defect `design-system.md`'s own "Hover
Pattern Mobile Alternatives" table exists to prevent (its own worked examples: "Message
timestamps — Always visible at 40% opacity", "Table action icons — Always visible at 60%
opacity"), and several sibling components in the same `chat/ui` tree already follow it
(`QueuePanel.tsx`, `WidgetFence.tsx`, `InlineTextField.tsx`, `SessionRowFull.tsx` all gate the
hover-reveal behind `md:`).

**Recommendation:** make the tooltip content reachable by tap — the simplest fix consistent with
the shipped pattern is swapping the CSS-only hover box for the existing `Tooltip` primitive (which
already has a documented use for "contextual information on icon-only buttons") or gating it
`md:group-hover:opacity-100` and rendering it always-visible-but-quieter below `md`, matching the
sibling components' pattern.

---

### [P2/M] Schedule builder's own controls opt out of touch scaling, inside a dialog that otherwise becomes a full-screen mobile drawer

**Files:** `apps/client/src/layers/features/tasks/ui/TaskBuilder.tsx:374-478`

`CreateTaskDialog` correctly uses `ResponsiveDialog` (confirmed via
`layers/features/tasks/ui/CreateTaskDialog.tsx:14-20`), so on a phone the create/edit-schedule
form becomes a full-screen `Drawer` — the right shell decision. But every `Select` inside
`ScheduleBuilder` explicitly opts back out of the scaling that shell implies:

```tsx
<SelectTrigger responsive={false} className="h-9" aria-label="Frequency">          {/* :375 */}
<SelectTrigger responsive={false} className="h-9 w-32" aria-label="Time">          {/* :401 */}
<SelectTrigger responsive={false} className="h-9 w-20" aria-label="Day of month">  {/* :468 */}
```

and the weekly day-of-week pills are hand-rolled at `px-2.5 py-1 text-xs` (:432-447) with no
touch-target consideration at all — no `responsive` prop exists to opt into for a bare `<button>`.
Unlike `button.tsx`'s deliberately-excluded `xs`/`icon-xs` sizes (which carry a comment
explaining they are "intentionally small UI chrome"), nothing here documents why this form's
Selects and day pills should stay at the fixed 36px/28px desktop density inside a surface the
product has already decided needs full-screen mobile treatment.

**Recommendation:** drop the three `responsive={false}` overrides (or replace with the system
default) and give the day-of-week toggle buttons the same `min-h-11`/`inset` touch-target
treatment `SidebarGroupAction` uses, consistent with the drawer shell they're rendered inside.

---

### [P2/M] FilterBar family blanket-disables touch scaling across `/tasks`, `/team`, and `/activity`

**Files:** `apps/client/src/layers/shared/ui/filter-bar/FilterBarSearch.tsx:20-26`,
`FilterBarAddFilter.tsx:172,205,246,262`, `FilterBarActiveFilters.tsx:101,112`,
`FilterBarResultCount.tsx:27`, plus the `SelectTrigger responsive={false}` /
`Input responsive={false}` call sites inside `FilterBarAddFilter.tsx`'s picker bodies
(min/max numeric range inputs at `:246,262`, clear buttons at `:172,205`).

Every `Button`/`Input`/`Select` this shared control-surface renders is explicitly passed
`responsive={false}`, e.g.:

```tsx
// FilterBarSearch.tsx:20-26
<Input responsive={false} placeholder={placeholder} … className="h-8 pl-8 text-sm sm:max-w-64" />
```

`FilterBar` is not a niche surface — it backs the toolbar on `TasksList` (`/tasks`), `AgentsList`
(`/team`), and `ActivityFilterBar` (`/activity`, via `ActivityPage.tsx`), all real routes with no
mobile redirect (checked `router.tsx` — none of the three redirects below 768px; they are simply
absent from the four-destination bottom bar `widgets/mobile-tabs` draws, which is a navigation
decision, not a route gate). `design-system.md` explicitly separates "content" surfaces from
"control" surfaces and gives control surfaces a denser desktop baseline (28–32px rows) — but the
whole point of `Button`/`Input`/`Select`'s `responsive` prop, per `button.tsx:44-59`'s own
comment, is to give exactly this class of control extra headroom below `md` regardless of its
desktop density. `FilterBar` forecloses that for every control it renders, everywhere it's used.

**Recommendation:** drop `responsive={false}` from the FilterBar primitives (or, if the dense
desktop row height must be preserved, use the pattern `Button`'s own `RESPONSIVE_SIZE_CLASSES`
demonstrates — a `md:`-scoped desktop override rather than disabling scaling outright).

---

### [P2/S] Overriding `Select`/`Button` height without `responsive={false}` produces mobile sizing _smaller_ than desktop

**Files:** `apps/client/src/layers/features/relay/ui/AdapterEventLog.tsx:101`,
`apps/client/src/layers/features/extensions/ui/SettingFieldRenderers.tsx:247`,
`apps/client/src/layers/features/relay/ui/ConversationRow.tsx:248`.

All three pass a raw height to `SelectTrigger` without setting `responsive={false}`:

```tsx
<SelectTrigger className="h-7 w-[130px] text-xs">   {/* AdapterEventLog.tsx:101 */}
<SelectTrigger className="h-8 text-sm">              {/* SettingFieldRenderers.tsx:247 */}
<SelectTrigger className="h-8 text-xs">               {/* ConversationRow.tsx:248 */}
```

`SelectTrigger`'s default (`select.tsx:19-26`) renders `responsive ? 'h-11 md:h-9' : 'h-9'`, and
`cn()`'s `tailwind-merge` resolves conflicts per _(modifier-set, class-group)_ pair: the caller's
unprefixed `h-7`/`h-8` shares an empty modifier set with the unprefixed `h-11`, so it wins that
conflict and `h-11` is dropped — but `md:h-9` carries a _different_ modifier set (`md`), so it
does not conflict with `h-7`/`h-8` and survives untouched. The rendered class list ends up as
`h-7 … md:h-9` (or `h-8 … md:h-9`): below the `md` breakpoint only the bare `h-7`/`h-8` rule
matches (28px/32px); at `md` and above, Tailwind's generated stylesheet places the `@media`
block after the base utilities, so `md:h-9` (36px) wins the cascade. The net, verified against
the actual CSS-merge mechanics rather than assumed, is **backwards** from the system's intent:
these three triggers render _smaller_ on a phone than on desktop, in a codebase whose entire
mobile-scale system exists to make controls larger below `md`, not smaller.

**Recommendation:** either pass `responsive={false}` (matching the pattern
`TaskRunHistoryPanel.tsx:445` already uses correctly for its own `h-7 w-[130px]` trigger) so the
control is a consistent fixed height at every width, or drop the custom height and accept the
system default. Worth a broader sweep: any `<Button className="h-…">`/`<SelectTrigger
className="h-…">` without an adjacent `responsive={false}` is a candidate for the same bug —
`AppTabItem`-adjacent components aside, a grep for `<Button` + explicit `h-` className with no
`responsive` prop turned up a further ~12 call sites (e.g. `IntegrationBindingCard.tsx:208`,
`ManifestSettingsPanel.tsx:362`, `PermissionPrimer.tsx:110,113`) that were not individually traced
for mobile-reachability within this pass and should be checked against the same mechanic.

---

### [P2/L] 225 raw `text-[Npx]` literals across 100+ files bypass the mobile type-scale multiplier

**Files (representative sample of ~100+ hit):**
`layers/features/mesh/ui/AgentNode.tsx` (8×), `layers/features/status/ui/ModelSelectionList.tsx`
(6×), `layers/features/status/ui/ModelConfigPopover.tsx` (5×), `layers/features/agent-settings/ui/
McpServerCardDetails.tsx` (4×), `layers/entities/agent/ui/PersonalityPicker.tsx` (4×),
`layers/shared/ui/sidebar-row.tsx:191,555`, `layers/shared/ui/section-header.tsx:187,214`,
`layers/features/dashboard-sidebar/ui/SessionSwitcher.tsx` (6× across two values), plus ~90 more
files with 1-3 occurrences each (full list gathered via
`grep -rEo "text-\[[0-9.]+(px|rem)\]" layers --include="*.tsx"`, 225 total hits).

`index.css:87-95` defines the scale tokens the design system's own "Mobile Responsive Scale"
section documents as the mechanism for text growing on mobile:

```css
--text-3xs: calc(0.625rem * var(--_st) * var(--user-font-scale, 1)); /* 10px → 12.5px mobile */
--text-2xs: calc(0.6875rem * var(--_st) * var(--user-font-scale, 1)); /* 11px → 13.75px mobile */
```

`--_st` is `1` on desktop and `var(--mobile-scale, 1.25)` below 768px (`index.css:45,79`). A
component using the Tailwind utility these compile to — `text-3xs`/`text-2xs` — scales
correctly (17 and 8 real usages found respectively). A component that instead writes the
_literal_ pixel value — `text-[10px]`, `text-[11px]`, `text-[0.625rem]`, `text-[0.6875rem]` (the
overwhelming majority of the 225 hits are exactly these four spellings of the two token values) —
renders the identical size on desktop but **never grows on mobile**, because an arbitrary Tailwind
value is a fixed literal, not a reference to the `--text-*` custom property the multiplier
modifies. The result is that two visually-identical 10px/11px labels sitting in different
components of the same UI (sidebar rows, status-strip items, mesh graph node chips, model
pickers) scale inconsistently on a phone — one grows to the intended 12.5–13.75px, its neighbor
using the raw value stays frozen at 10–11px — which is the "fonts that should get bigger on
mobile" failure mode named directly in this lens's brief, and it is reproducible today by reading
the token math rather than inferring it from a screenshot.

**Recommendation:** this is a mechanical sweep, not a design decision — replace `text-[10px]` →
`text-3xs` and `text-[11px]`/`text-[0.6875rem]` → `text-2xs` wherever the intent is "the small
metadata label this design system already has a token for," which is the overwhelming majority of
the 225 hits. A handful (e.g. `kbd.tsx:8`, keyboard-shortcut hints that are irrelevant on a
touchscreen; the `text-[13px]`/`text-[17px]` iOS-HIG values in `responsive-dropdown-menu.tsx`,
which are deliberately fixed per Apple's own spec, not the app's internal scale) are legitimate
exceptions and should stay literal — but they are a small minority of the total, not the pattern.

---

### [P3/S] Plain `Dialog` has no horizontal safe-margin below 640px — square corners, flush to the screen edge

**File:** `apps/client/src/layers/shared/ui/dialog.tsx:26-48`

```tsx
className={cn(
  'bg-background … fixed top-[50%] left-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border p-6 shadow-lg duration-200 sm:rounded-lg',
  className
)}
```

`DialogContent` is `position: fixed` with no positioned ancestor, so its containing block is the
viewport: `w-full` therefore means 100% of viewport width, capped only by `max-w-lg` (512px), with
no `mx-*`/`inset-x-*` gutter class anywhere in this file or in `DialogOverlay`. Below 512px-wide
viewports the dialog spans edge-to-edge with zero side margin, and `sm:rounded-lg` (640px) means
below that breakpoint it has **square corners** too — a stark, flush rectangle rather than the
inset card every other surface in the app presents. This is the primitive `design-system.md`
explicitly says to use "when the dialog content [does not need] full-screen treatment on mobile"
(i.e., it is meant to stay a small centered card, not go edge-to-edge) — the 30+ call sites still
using plain `Dialog` (simple confirms like `StopConfirmDialog`, `ResetDialog`,
`AutoModeConfirmDialog`, and heavier ones like `TasksDialog.tsx:32` at `max-w-3xl`) all inherit
this gap. It is not a content-overflow bug — nothing scrolls horizontally — but it is a real,
if minor, Calm Tech miss: a modal that should read as a floating card instead reads as a flush
panel purely because of a missing few Tailwind classes.

**Recommendation:** add a horizontal safe margin (e.g. `w-[calc(100%-2rem)]` or `inset-x-4`) and
drop the `sm:` prefix from `rounded-lg` so every plain `Dialog` keeps its card identity at every
width, matching what `TabbedDialog`/`ResponsiveDialog` already do correctly for their own
content.

---

## Patterns already shipped correctly (for calibration, not findings)

Noted during this pass so they are not re-flagged by a synthesizer skimming file names: the
`Button`/`Input`/`Select` `responsive` prop system (`h-11 md:h-9` etc.) is a well-designed,
already-adopted mechanism; `QueuePanel.tsx`, `WidgetFence.tsx`, `InlineTextField.tsx`, and
`SessionRowFull.tsx` all correctly gate their hover-reveal chrome behind `md:` with an
always-visible mobile fallback; `RightPanelContainer.tsx` correctly swaps to a full-width `Sheet`
on mobile; `TabbedDialog`/`NavigationLayout` correctly drill-in on mobile and is what
`SettingsDialog` builds on; `DataTable`'s `meta.hideOnMobile` is correctly used by
`agent-columns.tsx`; `EntryReactionPicker`'s popover body is deliberately shared between a
desktop `Popover` and a touch long-press drawer, not a hover-only miss.
