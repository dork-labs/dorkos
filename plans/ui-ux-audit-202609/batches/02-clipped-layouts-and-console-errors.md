[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 2 — Clipped layouts and console errors on load

**Priority P1 · 5 findings · 2S · 3M**
**Scope:** surfaces that render wrong or noisy the moment they load, before any interaction. Two of these need a browser check after the fix.

### 2.1 — Schedules empty state renders clipped behind the header on phone

**P1 · S · lenses 8 + 9**
`apps/client/src/layers/widgets/tasks/ui/TasksPage.tsx:105-116`, `apps/client/src/layers/features/tasks/ui/TasksEmptyState.tsx:19-36`

**Evidence.** `/tasks` at 390×844, cold load: "No schedules yet." renders with its top half cut off behind the sticky header. A boxed accessibility snapshot puts the empty-state wrapper's computed box at `[x=0, y=-10, w=390, h=845]` — it starts 10px _above_ the viewport. `TasksPage.tsx:110` wraps `TasksEmptyState` in a bare `motion.div className="flex h-full flex-col items-center justify-center"` with **no scroll container**, unlike the data branch three lines below which correctly wraps `TasksList` in `<PageContainer width="full" scroll={false}>`. The content (heading + subtext + four template cards + a link, ≈770px) is taller than the ≈752px region, and `justify-center` pushes the overflow equally above and below — so the top is off-screen and unreachable.

**Recommendation.** Wrap the empty-state branch in the same `PageContainer` the data branch already uses, and swap `justify-center` for `justify-start` with top padding. A screen that has to hold a four-card gallery should never be vertically centred.

### 2.2 — Marketplace grid keys off viewport width, not the column's real width — 78px cards under any docked panel

**P1 · M · lens 8**
`apps/client/src/layers/features/marketplace/ui/PackageGrid.tsx:146`, `apps/client/src/layers/features/marketplace/ui/FeaturedRail.tsx:30,51`

**Evidence.** At a 768px viewport with the sidebar and the Pulse panel both docked — an ordinary state — the routed content column measures 236px (verified via bounding boxes: `main` at `[288,44]`, 472px split by a resizable divider into two 236px halves). `PackageGrid` uses `grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4` and `FeaturedRail` uses `grid-cols-1 sm:grid-cols-2 md:grid-cols-3`. `md:` fires on _viewport_ width, so three columns render into 236px: cards ~78px wide, names cut mid-word ("Code Revie", "Secur"), badges cut to "AGEN"/"PLUGI…", Install buttons overlapping, and a horizontal scrollbar under the rows because 78px cannot contain the card's own min-content.

**Recommendation.** This is the textbook "viewport breakpoint on a component whose width is set by sibling panels" bug. Swap the `sm:`/`md:`/`lg:` grid-cols for Tailwind v4 container-query variants (`@container` on the routed page container, `@sm:`/`@md:` on the grid) so column count tracks available width. One change self-heals tablet and phone too, with no per-breakpoint special-casing.

### 2.3 — At 768px with the right panel docked, the page-tab strip collapses to 16px

**P1 · M · lens 8**
`apps/client/src/layers/shared/ui/bar-tab-strip.tsx:142-158`, `apps/client/src/layers/features/right-panel/ui/RightPanelContainer.tsx:59-67`, `apps/client/src/layers/widgets/one-bar/ui/HomeSurfaceBar.tsx`

**Evidence.** `/` at 768×1024 with sidebar + Pulse docked: the `Home sections` nav (Home / Activity / Schedules / Workspaces) measures **16px wide** — no label visible, not even a partial one with the documented fade cue. `BarTabStrip` is `flex-initial` with `overflow-x-auto` and no `min-width` floor, so under pressure from the health dot, the members chip and the `shrink-0` fixed cluster it collapses toward zero. The same squeeze starves the content column: on `/activity` the one-line stat "Your agents started 1 session this week" wraps to seven lines of one or two words, and the list rows need a horizontal scrollbar to reach "Open →".

This is **not** the documented phone trade-off (DOR-1180, "four labels do not fit a phone… the strip scrolls sideways, and says so") — that assumes the strip keeps some visible width and a fade. At 768px with two docked panels it keeps neither.

**Recommendation.** Two complementary fixes. (a) Give `BarTabStrip` a `min-width` floor, or guarantee the active tab stays legible, so it never degrades below "one readable tab plus fade". (b) Treat 768–1023px as a real tablet tier where the right panel defaults to the overlay/Sheet presentation already built for phone, rather than the docked three-pane split. `useIsMobile()`'s 768px cutoff currently means "everything above is desktop-roomy", which this configuration disproves.

### 2.4 — Repeated React `flushSync` console errors on every cold load

**P1 · M · lens 9**
`apps/client/src/layers/features/dashboard-sidebar/ui/rooms/RoomRow.tsx:196-204`, `apps/client/src/layers/shared/ui/sidebar-menu-node.tsx:758-763`

**Evidence.** Console on `/` at first load: 7× `flushSync was called from inside a lifecycle method. React cannot flush when React is already rendering.` Reproduced on `/session` (2×). `RoomRow`'s `wake()` calls `flushSync(() => setAwake(true))` and is wired to `SidebarRow`'s `onMenuIntent`, which `sidebar-menu-node.tsx:763` binds to `onFocusCapture`. A capture-phase focus handler can fire synchronously during React's own commit work — for example focus restoration on mount — which is exactly the situation the warning describes. The documented intent (a deliberate synchronous latch so the "⋮" has its acts in hand by the time `pointerdown` finishes bubbling) is sound; the focus path is not covered by it.

**Recommendation.** Trace which rows receive programmatic focus at mount (virtualization remount, or an active row auto-focusing), and defer `wake()` with `queueMicrotask`/`requestAnimationFrame` when it is triggered by focus rather than by a real pointer event. Keep `flushSync` on the `pointerdown`/`contextmenu` paths it was designed for.

### 2.5 — Plain `Dialog` has no horizontal safe margin below 640px

**P3 · S · lens 8**
`apps/client/src/layers/shared/ui/dialog.tsx:26-48`

**Evidence.** `DialogContent` is `fixed` with `w-full max-w-lg` and no `mx-*`/`inset-x-*` gutter anywhere in the file. Below 512px the dialog spans edge to edge with zero side margin, and `sm:rounded-lg` means below 640px it also has square corners — a flush rectangle rather than the inset card every other surface presents. Roughly 30 call sites still use plain `Dialog` (`StopConfirmDialog`, `ResetDialog`, `AutoModeConfirmDialog`, `TasksDialog`).

**Recommendation.** Add a horizontal safe margin (`w-[calc(100%-2rem)]` or `inset-x-4`) and drop the `sm:` prefix from `rounded-lg`, so a plain `Dialog` keeps its card identity at every width — matching what `TabbedDialog`/`ResponsiveDialog` already do.
