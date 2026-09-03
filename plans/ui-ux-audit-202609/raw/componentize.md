# Componentization — Lens 12 Findings

## Coverage

**Examined in full:** `apps/client/src/layers/shared/ui/` directory listing (99 entries) and read
in full: `section-header.tsx`, `setting-row.tsx`, `field-card.tsx`, `field.tsx`, `option-row.tsx`,
`compact-result-row.tsx`, `card.tsx`, `badge.tsx`, `progress.tsx`, `skeleton.tsx`, `separator.tsx`,
`tabs.tsx`, `select.tsx`, `checkbox.tsx`, `radio-group.tsx`, `switch.tsx`, `tooltip.tsx`,
`slider.tsx`, `input.tsx`, `copy-button.tsx`, `dropdown-menu.tsx` (partial), `status-dot.ts`
(partial). These cover most of the "already-solved" primitives a duplicate would be measured
against.

**Sampled by grep-then-read across `features/`, `widgets/`, `entities/`:** empty-state
components (7 read in full: `TopologyEmptyState`, `MeshEmptyState`, `TasksEmptyState`,
`ChatEmptyState`, `PackageEmptyState`, `ActivityEmptyState`, `RelayEmptyState`), the three
`feature-promos` dialogs (read in full), four independently-defined "label/value row" components
(`DetailRow`/`Row`, read in full), five "pill/chip" components (`CategoryBadge`, `ScopeBadge`,
`ActorBadge`, `BridgeVisibilityBadge`, plus the two removable-filter-chip call sites), the
destructive-error-state block repeated across four page-level widgets, and ~15 files matched by a
`bg-card ... rounded-* border` grep as candidate ad-hoc `Card` reimplementations (3 read in full
to confirm).

**Not covered:** the 92 dev-playground showcase files, the `entities/` layer beyond the files
above, `widgets/app-layout`, `dropdown-menu.tsx`/`popover.tsx`/`dialog.tsx`/`context-menu.tsx`
beyond a skim, and anything under `apps/client/src/dev/`. Findings are grep-seeded, so patterns
that don't share a recognizable class-string or component name (e.g. duplicated logic expressed
with structurally different markup) are under-represented — this is a sample, not an exhaustive
AST diff.

---

### [P2/M] Four page-level widgets hand-roll the identical "couldn't load, retry" error state

**Files:**
`apps/client/src/layers/widgets/tasks/ui/TasksPage.tsx:84-97`,
`apps/client/src/layers/widgets/team/ui/TeamPage.tsx:116-129`,
`apps/client/src/layers/widgets/team/ui/TeamRoute.tsx:96-109`,
`apps/client/src/layers/features/feedback-requests/ui/FeedbackRequestsPanel.tsx:142-158`

**Evidence:** all four blocks share the exact same outer class
(`flex h-full flex-col items-center justify-center gap-3 p-8 text-center`), the exact same icon
wrapper (`bg-destructive/10 rounded-xl p-3` around a `TriangleAlert` icon at `size-6`), the same
two-line message structure (`text-sm font-medium` headline + `text-muted-foreground text-xs`
supporting line), and the same `Button size="sm" onClick={() => void refetch()}` retry action.
Only the two lines of copy differ ("Could not load your team" / "…your scheduled tasks" /
"…agents" / "…your reports").

**Why it falls short:** this is copy-pasted markup appearing 4 times (the conventions.md 3-strike
DRY rule), not a coincidental resemblance — the structure, spacing, and even the Tailwind
class order are identical. A fifth query-error surface will almost certainly copy the fourth
rather than reach for a shared component, because there isn't one to reach for.

**Recommendation:** extract a `QueryErrorState` (or `RetryErrorState`) component in `shared/ui`
taking `title`, `description`, and `onRetry`, and swap all four call sites onto it. Effort is
small per call site but crosses widget/feature boundaries, so scope it as one slice.

---

### [P2/M] Seven independent "icon + headline + description [+ CTA]" empty-state components

**Files:** `apps/client/src/layers/features/mesh/ui/TopologyEmptyState.tsx`,
`apps/client/src/layers/features/mesh/ui/MeshEmptyState.tsx`,
`apps/client/src/layers/features/tasks/ui/TasksEmptyState.tsx`,
`apps/client/src/layers/features/chat/ui/ChatEmptyState.tsx`,
`apps/client/src/layers/features/marketplace/ui/PackageEmptyState.tsx`,
`apps/client/src/layers/features/activity-feed-page/ui/ActivityEmptyState.tsx`,
`apps/client/src/layers/features/relay/ui/RelayEmptyState.tsx`

**Evidence:** `MeshEmptyState` (lines 1-46) is already the generic shape the charter describes:
`icon: LucideIcon`, `headline: string`, `description: string`, optional `action`, optional
`preview`. `TopologyEmptyState` (lines 1-29) and `PackageEmptyState` (lines 1-52) each re-derive
the same layout by hand — `flex flex-col items-center justify-center gap-3 text-center`, an icon
at `size-10`/`size-6` wrapped in a muted rounded box, an `h3`/`p` pair, an optional outline
button — with small unexplained deltas (`MeshEmptyState` wraps its icon in
`bg-muted/50 rounded-xl p-3`, `ActivityEmptyState` uses `bg-muted rounded-full p-4`,
`PackageEmptyState` draws the icon bare with no wrapper at all; padding varies between
`p-12`, `py-16`, `px-6 py-8 md:py-12`, and `py-16`).

**Why it falls short:** `MeshEmptyState` already proves the generic component was worth writing —
`DeniedView.tsx:1-30` reuses it across a sibling feature — but it stayed scoped to
`features/mesh/` instead of moving to `shared/ui`, so every other feature reinvented the same
icon/headline/description/CTA shape independently rather than discovering it.
`ChatEmptyState`, `TasksEmptyState`, and `RelayEmptyState` carry enough bespoke content (state
machine branching, a template gallery, a full "ghost preview" mockup) that they should stay
custom — but `TopologyEmptyState`, `PackageEmptyState`, and the two branches of
`ActivityEmptyState` are plain instances of the generic shape with nothing bespoke about them.

**Recommendation:** promote `MeshEmptyState`'s shape to `shared/ui` (e.g. `EmptyState`, keeping
the `preview` slot), then migrate `TopologyEmptyState`, `PackageEmptyState`, and
`ActivityEmptyState`'s two internal variants onto it, deleting the bespoke wrapper components.
Leave `ChatEmptyState`, `TasksEmptyState`, and `RelayEmptyState` as feature-owned compositions
that may render the shared primitive internally where a branch of theirs matches it.

---

### [P2/M] Four features independently invented the same "label left, value right" row

**Files:**
`apps/client/src/layers/features/agent-settings/ui/McpServerCardDetails.tsx:19` (`DetailRow`),
`apps/client/src/layers/features/status/ui/UsageStatusItem.tsx:26` (`DetailRow`),
`apps/client/src/layers/features/status/ui/SessionInspector.tsx:304` (`Row`),
`apps/client/src/layers/entities/session/ui/SessionDetailsPanel.tsx:146` (`DetailRow`)

**Evidence:**

- `McpServerCardDetails.tsx:19-23`: `grid grid-cols-[5.5rem_1fr]`, label at
  `text-muted-foreground/70 text-xs`, value at `text-muted-foreground text-xs leading-relaxed`.
- `UsageStatusItem.tsx:26-33`: `flex justify-between gap-3`, label at `text-muted-foreground`,
  bare value.
- `SessionInspector.tsx:304-340`: `flex items-baseline gap-2`, adds `wrap`, `indent`, and
  `swatch` (a colour dot) props the other three don't have.
- `SessionDetailsPanel.tsx:146-161`: `flex items-start gap-2`, fixed `w-16` label column, adds a
  `copyable` prop that renders `CopyButton`.

Four names for the same idea (three call it `DetailRow`, one calls it `Row`), four different
flex/grid strategies to align the same two columns, and four different subsets of the
`wrap`/`indent`/`swatch`/`copyable` features a "detail row" plausibly needs — each feature
re-derived its own subset instead of inheriting the union.

**Why it falls short:** this is the conventions.md 3-strike DRY rule at 4 strikes, and it is
exactly the "labeled key-value rows" pattern lens 12 names explicitly. `shared/ui` already has
`field.tsx`/`field-card.tsx`/`setting-row.tsx` for form-oriented label/control pairs, but nothing
for read-only label/value display — so every panel that needed one wrote its own.

**Recommendation:** design one `DetailRow` (or `KeyValueRow`) in `shared/ui` that is the union of
the four call sites' props (`label`, `children`/`value`, `wrap`, `indent`, `swatch`, `copyable`,
`valueClassName`), then migrate all four private implementations onto it. This is the single
highest-value extraction in this lens: it removes real, currently-diverging duplication rather
than pre-emptively unifying things that happen to look similar.

---

### [P2/S] `TaskRow`'s status dot reinvents the raw-palette bug `status-dot.ts` was written to fix

**Files:** `apps/client/src/layers/features/tasks/ui/TaskRow.tsx:72-82`;
compare `apps/client/src/layers/shared/ui/status-dot.ts:1-10`

**Evidence:** `status-dot.ts`'s own module doc says: _"[a] coloured dot is the smallest thing this
product draws and the one it drew five different ways: a green that was `bg-green-500` in the
sidebar, `bg-emerald-500` in an agent panel, `bg-status-success` in a room and `bg-primary` in a
group header … This module is the spelling."_ `TaskRow.tsx`'s `StatusDot` function, still in the
tree today, draws exactly that bug: `'bg-yellow-500'` for `pending_approval`, `'bg-neutral-400'`
for disabled, `'bg-green-500'` otherwise (line 76-79) — raw Tailwind palette classes, none of them
theme tokens, none of them going through `statusDotClass`. Every other status dot grepped for this
audit (`RoomRow.tsx:413`, `SessionSwitcher.tsx:423`, `SessionRowSidebar.tsx:248`) correctly calls
`statusDotClass(...)`.

**Why it falls short:** it is a live counter-example to the exact consolidation `status-dot.ts`
shipped to end, sitting in a feature that was apparently never migrated. It also fails the "no
raw hex" spirit of the design system (`bg-green-500` doesn't shift with the theme the way
`bg-status-success` does) and reads a different green/yellow than every sidebar/room status dot
in the app.

**Recommendation:** add a task-appropriate case to `status-dot.ts`'s vocabulary (or map
`pending_approval`/`disabled`/`enabled` onto the existing `needs-you`/`idle`/`working` signals if
they fit) and call `statusDotClass` from `TaskRow.tsx` instead of hand-rolling colour classes.

---

### [P2/M] Domain "badge" components reimplement the pill shell instead of composing `Badge`

**Files:** `apps/client/src/layers/entities/activity/ui/CategoryBadge.tsx:20-32`,
`apps/client/src/layers/entities/marketplace/ui/ScopeBadge.tsx:28-39`,
`apps/client/src/layers/entities/activity/ui/ActorBadge.tsx:30-42` (the `user` branch),
`apps/client/src/layers/entities/room/ui/BridgeVisibilityBadge.tsx:71-74`; compare
`apps/client/src/layers/shared/ui/badge.tsx:5-19`

**Evidence:** the shared `badgeVariants` shell is
`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium`. None of the four
domain badges above import `Badge` — each hand-writes its own version of the same shell with
small, unexplained drift: `CategoryBadge` uses `rounded-full px-2 py-0.5`, `ScopeBadge` uses
`rounded-full px-1.5 py-0.5 text-[9px] ... uppercase`, `ActorBadge`'s neutral variant uses
`rounded-full border px-2 py-0.5 text-xs`, `BridgeVisibilityBadge` uses
`h-6 ... rounded-full border px-2.5 text-[11px]`. Four call sites, four slightly different pill
geometries, none of them the actual `Badge` component.

**Why it falls short:** these aren't cosmetic near-misses — they're the same UI idea (a small
coloured status/category pill) re-typed by hand four times, and the base `Badge` primitive can't
currently produce any of them because it only ships a `rounded-md` box shape, not the
`rounded-full` pill shape every one of these four wanted. `shared/ui` is meant to be the thing
these compose; today it's a shape `Badge` doesn't offer, so nobody reaches for it.

**Recommendation:** add a `shape: 'default' | 'pill'` (or similar) variant to `badgeVariants` in
`badge.tsx` so the pill geometry is available from the primitive, then have `CategoryBadge`,
`ScopeBadge`, and `ActorBadge`'s neutral case compose `<Badge shape="pill" className={colorClass}>`
instead of re-deriving the shell. `BridgeVisibilityBadge` is a disclosure trigger styled as a
label (its own doc is explicit that it must never look like a `Badge`/toggle), so leave it as a
`<button>` — but it can still pull its shell classes from the same `badgeVariants({shape:'pill'})`
output for visual consistency without claiming to be a `Badge`.

---

### [P3/S] Two near-identical "removable filter chip" implementations

**Files:** `apps/client/src/layers/features/tasks/ui/TasksPanel.tsx:211-224` (`AgentFilterChip`),
`apps/client/src/layers/shared/ui/filter-bar/FilterBarActiveFilters.tsx:134-142`

**Evidence:** both render a `rounded-full border px-2 text-xs` pill with a label and a trailing
`X` button styled `hover:text-foreground -mr-0.5 rounded-full p-0.5`. `TasksPanel.tsx`'s version
is a private component in a feature file; `FilterBarActiveFilters.tsx` is itself already a
`shared/ui` component, so the shared implementation exists but the feature didn't reach for it
(the filter-bar's chip is coupled to `FilterBarContext`, which `TasksPanel`'s agent filter isn't
wired to — that's likely why it wasn't reused directly).

**Why it falls short:** only two instances today (below the 3-strike DRY threshold, so this is
P3 rather than P2), but it's the exact same visual/interaction contract drawn twice for no
reason other than one being inside a context-coupled component. A third ad-hoc filter chip
elsewhere in the app is a likely next occurrence given how common dismissible filters are.

**Recommendation:** extract the presentational half — label + dismiss button, no context
dependency — as a standalone `<RemovableChip label onRemove>` in `shared/ui`, and have both
`FilterBarActiveFilters` and `TasksPanel`'s `AgentFilterChip` render it.

---

### [P2/M] ~10 files hand-roll the `Card` shell instead of importing `Card`

**Files (spot-checked in full):**
`apps/client/src/layers/features/connections/ui/ProviderSetupCard.tsx:48`,
`apps/client/src/layers/features/connections/ui/ClaimCard.tsx:114`,
`apps/client/src/layers/features/extensions/ui/ExtensionCard.tsx:64`

**Also grep-matched (not individually read), same `bg-card ... rounded-* border` shell:**
`features/mesh/ui/AgentNode.tsx`, `features/marketplace/ui/PackageLoadingSkeleton.tsx`,
`features/gen-ui/ui/WidgetSkeleton.tsx`, `features/gen-ui/ui/WidgetErrorCard.tsx`,
`features/connections/ui/AgentAccounts.tsx`, `features/connections/ui/AccountsList.tsx`,
`features/connections/ui/ServiceGrid.tsx`, `features/connections/ui/AccountsFirstRun.tsx`,
`features/notifications/ui/PermissionPrimer.tsx`, `features/onboarding/ui/OnboardingWidgetCard.tsx`

**Evidence:** `shared/ui/card.tsx:5-16` defines `Card` as exactly
`bg-card text-card-foreground shadow-soft flex flex-col gap-4 rounded-lg border p-4`.
`ProviderSetupCard.tsx:48` is a bare `<div className="bg-card rounded-lg border p-4">` — the same
classes (minus `shadow-soft`/`gap-4`/`text-card-foreground`) on a plain `div` instead of `<Card>`.
`ClaimCard.tsx:114` is the same idea with `shadow-soft` added back by hand:
`"bg-card shadow-soft space-y-3 rounded-lg border p-4"`. `ExtensionCard.tsx:64` imports `Badge`,
`Button`, and `Switch` from `shared/ui` in the same file (line 4) but still hand-writes
`'bg-card rounded-xl border p-4'` for its own outer shell rather than using `Card`.

**Why it falls short:** this is the clearest "ad-hoc reimplementation of something shared/ui
already solves" in the sample — the component exists, is imported for its siblings in the same
file, and is skipped for the one job it does. Every hand-rolled copy is one more place a future
radius/shadow/padding change to `Card` won't reach.

**Recommendation:** sweep the ~10 grep hits and swap the outer wrapper for `<Card>` (with
`CardContent`/`CardFooter` where the internal structure already separates a body from actions).
Where a file genuinely needs `rounded-xl` instead of `Card`'s `rounded-lg`, that's a signal `Card`
is missing a size/shape variant (see the primitives section below) rather than a reason to keep
reimplementing it.

---

### [P2/S] Three feature-promo dialogs are the same layout, copy-pasted three times

**Files:**
`apps/client/src/layers/features/feature-promos/ui/dialogs/SchedulesDialog.tsx:15-32`,
`apps/client/src/layers/features/feature-promos/ui/dialogs/RelayAdaptersDialog.tsx:15-33`,
`apps/client/src/layers/features/feature-promos/ui/dialogs/AgentChatDialog.tsx:14-32`

**Evidence:** all three are `import type { PromoDialogProps } from '../../model/promo-types'` and
render, in order: (1) a `flex items-center gap-3` header — `size-10` icon badge in a
`rounded-lg bg-gradient-to-br from-{color}-500/10 to-{color}-600/10` box, next to an
`h3 text-sm font-medium` + `p text-muted-foreground text-xs` pair; (2) a
`bg-muted/50 space-y-3 rounded-lg p-4` box containing exactly two `flex items-start gap-3`
bullets, each an icon + `text-xs font-medium` title + `text-muted-foreground text-xs`
description; (3) a `flex justify-end gap-2` footer with a ghost "dismiss" button and a primary
CTA button. The only things that differ across the three files are the icon choices, the gradient
colour (indigo/purple/emerald), and the copy strings.

**Why it falls short:** this is a 3-for-3 structural copy — every promo dialog that exists today
follows the identical layout, so the next promo dialog (there will be more; this is a `dialogs/`
directory with a shared `PromoDialogProps` type designed for growth) is very likely to be a
fourth copy-paste rather than a composition. The gradient icon badge
(`bg-gradient-to-br from-*-500/10 to-*-600/10`) is also worth a second look against the design
system's "Purple/brand gradients" anti-pattern (`contributing/design-system.md` Anti-Patterns) —
flagged here only as a byproduct of the duplication, since the color-per-surface choice itself is
a tokens/consistency question for another lens.

**Recommendation:** extract a `PromoDialogLayout` (icon, iconTint, title, subtitle,
`highlights: {icon, title, description}[]`, `primaryAction`, `secondaryAction`) in
`features/feature-promos/ui/`, and rewrite all three dialogs as data passed to it. A fourth promo
dialog then costs a data literal instead of 30-some lines of re-typed markup.

---

### shadcn primitives in `shared/ui` still near-stock — concrete upgrade ideas

The charter also asks which primitives are worth customizing further. Reviewed every primitive
listed in Coverage above; most (`Switch`, `Select`, `Input`, `Tabs`) already carry real DorkOS
customization (a `responsive` prop with mobile/desktop sizing, multiple `SwitchSize`s). The ones
below are close to shadcn's stock output and have a concrete, Calm-Tech-compatible next step:

- **`Card` (`shared/ui/card.tsx:1-16`)** — a single fixed shape, no `cva` variants at all, despite
  `contributing/design-system.md`/`.claude/rules/components.md` documenting a `card-interactive`
  utility (hover lift: elevated shadow + firmer border) specifically for this component. Only 4
  files in the whole client apply `card-interactive` — everywhere else that wants a hoverable
  card either skips the affordance or hand-writes the hover classes (see the `Card`
  reimplementation finding above, several of which want `rounded-xl` instead of `rounded-lg`).
  **Upgrade idea:** add `variant: 'static' | 'interactive'` (wiring in `card-interactive`) and a
  `size`/`radius` variant via `cva`, matching the pattern every other primitive in this folder
  already uses.

- **`Badge` (`shared/ui/badge.tsx:5-19`)** — only a `variant` (color) axis, `rounded-md` box shape
  only. As shown above, four domain components independently wanted a `rounded-full` pill instead
  and none of them could get it from `Badge`. **Upgrade idea:** add the `shape` variant (see the
  Badge finding above) and an optional leading `dot`/`icon` slot — several call sites
  (`ActorBadge`'s agent branch, `UpdatePill`, mesh node badges) already hand-pair a coloured dot
  next to a label; a `dot` prop on `Badge` would make that a single import instead of a bespoke
  `<span>` beside every one of them.

- **`Slider` (`shared/ui/slider.tsx:9-57`)** — a faithful, largely-unmodified port of the shadcn
  slider. Two concrete issues: the thumb is hardcoded `bg-white` (line 52) rather than a theme
  token — the one hardcoded color found in this pass, and a direct instance of the "never
  hardcode colors" rule in `.claude/rules/components.md` — and there is no value readout while
  dragging, so a user moving a slider (e.g. `entities/agent/ui/TraitSliders.tsx`) gets no
  numeric feedback until they let go and read it elsewhere. **Upgrade idea:** swap `bg-white` for
  `bg-background`, and add an optional `showValueOnDrag` tooltip (Radix `Tooltip` already exists
  in this folder) that appears only while the thumb is actively dragged — a small, quiet
  micro-interaction squarely inside Calm Tech's "chrome on hover/focus" rule, not a new
  decoration.

- **`Progress` (`shared/ui/progress.tsx:1-31`)** — determinate only; there is no indeterminate
  state for "working, no known percentage." Several long-running operations in the app currently
  fall back to a spinner or an animated `Skeleton` in places a slim indeterminate progress bar
  would read more calmly (e.g. transitional loading rows). **Upgrade idea:** an
  `indeterminate` boolean that swaps the fixed-width fill for a CSS `animate-tasks`-style sliding
  segment — reusing the shimmer keyframe `Skeleton` already carries rather than inventing a new
  one, keeping it inside the existing motion vocabulary.

---

## Summary of severity distribution

- **P1:** 0 — nothing in this lens rose to "visibly broken" or a Hard Rule violation; every
  finding here is duplicated-but-working markup, which is a quality gap rather than a defect.
- **P2:** 7 — error-state duplication, empty-state family, detail-row family, TaskRow status dot,
  Badge/pill shell duplication, Card shell duplication, promo-dialog duplication.
- **P3:** 1 — removable filter chip duplication — plus the primitives-worth-customizing section,
  which is advisory (upgrade ideas) rather than a numbered defect list.
