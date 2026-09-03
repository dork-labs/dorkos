# UI/UX Audit — Findings

**Scope:** `apps/client/src` (940 component files) · **Date:** 2026-09-03 · **Charter:** [`00-charter.md`](00-charter.md)
**Method:** twelve code-reading lenses + four live-browser passes + operator-confirmed bugs. Raw per-lens reports live in [`raw/`](raw/).

---

## Executive summary

The DorkOS client is well built and, in places, better than the industry norm — the session status line, the sidebar's bottom-slot arbiter, the message layer's motion, and the roving-focus sidebar are all reference-quality. The gaps are concentrated in three places: the shared primitives everything else is built from, the general app chrome that never got the attention the chat surfaces did, and long strings that escape their containers on small screens. Four defects are visibly broken to a new user today: a filesystem path runs off the Workspaces card and off the phone screen, the Schedules empty state renders clipped behind its own header, every marketplace card truncates its author and source to single unreadable characters, and the marketplace grid collapses to 78px cards whenever a side panel is docked. Two accessibility failures matter more than their size suggests: the sort-direction toggle in the shared filter bar cannot be reached by keyboard at all, and schedule template cards read their entire prompt aloud as the button's name. A CSS rule written outside any cascade layer silently repaints every coloured border in the app as plain grey across 69 files, so error, warning and selection cues that authors intended simply are not there. The base `Button` — the most-used primitive in the codebase — has no press feedback, which is why fifteen call sites invented nine different press values of their own. Copy is the largest single lens: one concept carries three names (session, conversation, chat), an accepted ADR's retired vocabulary is still on screen, and the app's default error voice is "Failed to…" with the raw server message pasted in front of the authored sentence. The `shared/ui` directory was fenced off from the repo's own TSDoc and file-size rules on a "vendored shadcn" premise that stopped being true dozens of hand-written primitives ago, and findings across four lenses trace back to that one exemption. Nothing in this report asks for more decoration: the large majority of recommendations delete code, merge two things into one, retime existing motion, or shorten a sentence.

---

## Stats

**189 raw findings → 167 after dedup and verification.** Two findings were dropped and one narrowed (see [Dropped](#dropped-and-narrowed)); 20 were merged where two or more lenses saw the same underlying defect.

| Lens                      |     P1 |     P2 |     P3 |   Total |
| ------------------------- | -----: | -----: | -----: | ------: |
| 1 · Tokens & consistency  |      2 |      4 |      3 |       9 |
| 2 · Composition & CVA     |      2 |     12 |      2 |      16 |
| 3 · DRY                   |      0 |      2 |      3 |       5 |
| 4 · Organization & naming |      0 |      5 |      2 |       7 |
| 5 · DX                    |      1 |     12 |      7 |      20 |
| 6 · Playground            |      0 |      6 |      4 |      10 |
| 7 · Copy (ELI5)           |      2 |     16 |      8 |      26 |
| 8 · Responsiveness        |      7 |      9 |      3 |      19 |
| 9 · UI states             |      4 |      8 |      3 |      15 |
| 10 · Motion               |      1 |      9 |     12 |      22 |
| 11 · Clutter & disclosure |      0 |      9 |      3 |      12 |
| 12 · Componentization     |      0 |      5 |      1 |       6 |
| **Total**                 | **19** | **97** | **51** | **167** |

**Effort mix:** 121 S · 39 M · 7 L.

### Batches at a glance

| #   | Batch                                           | Pri | Findings | Effort       |
| --- | ----------------------------------------------- | --- | -------: | ------------ |
| 1   | Overflow containment                            | P1  |        7 | 6S · 1M      |
| 2   | Clipped layouts and console errors on load      | P1  |        5 | 2S · 3M      |
| 3   | Keyboard and screen-reader gaps                 | P1  |        5 | 4S · 1M      |
| 4   | Tokens that don't paint                         | P1  |        9 | 5S · 2M · 2L |
| 5   | Press, hover and focus in the shared primitives | P1  |       10 | 9S · 1M      |
| 6   | Rows and cards missing their own states         | P2  |        8 | 8S           |
| 7   | Touch targets and hover-only affordances        | P1  |        8 | 4S · 4M      |
| 8   | Copy: honesty and settled vocabulary            | P1  |        7 | 4S · 2M · 1L |
| 9   | Copy: register, casing and the error voice      | P2  |        9 | 4S · 5M      |
| 10  | Copy: typography and stragglers                 | P3  |        7 | 5S · 2M      |
| 11  | No wall of text                                 | P2  |        4 | 3S · 1M      |
| 12  | Settings information architecture               | P2  |        6 | 5S · 1M      |
| 13  | The session surface: fewer things competing     | P2  |        5 | 1S · 4M      |
| 14  | Shared primitives: composition debt             | P2  |       13 | 8S · 3M · 2L |
| 15  | `shared/ui` library hygiene                     | P1  |       14 | 6S · 7M · 1L |
| 16  | Docs and discoverability                        | P2  |        7 | 4S · 3M      |
| 17  | Componentization: extract what's been copied    | P2  |       12 | 5S · 7M      |
| 18  | Motion: back inside the timing system           | P2  |       14 | 11S · 3M     |
| 19  | FSD placement and naming                        | P2  |        7 | 5S · 2M      |
| 20  | Dev Playground: organization and coverage       | P2  |       10 | 7S · 3M      |

### Dropped and narrowed

- **Dropped — "Dev server fails to boot the client on every route"** (`raw/browser-playground.md`). An environment failure (two Vite optimize-deps chunks 404ing from a running dev server), not an application defect; the auditor states plainly that no `file:line` fix applies. Charter rule 1. **Consequence: the playground was never audited in a live browser** — every lens-6 finding below is source-read only, and a browser pass over `/dev`'s 24 pages remains an open coverage gap.
- **Dropped — "`/session` with no id resolves to a deleted session, producing two 404s"** (`raw/browser-desktop.md` #11). Real observed behaviour, but the auditor records "route `/session` — not directly inspected", so it carries no `file:line`. Re-file after tracing the redirect.
- **Narrowed — "Two dead exports in `shared/ui`"** (`raw/organization.md`). `SettingsPanel` is genuinely dead (barrel + its own test only, verified). `NavigationLayoutSectionHeader` is **not** dead — it is rendered at `shared/ui/tabbed-dialog.tsx:195`. That half is removed; the finding survives as `SettingsPanel` alone.

### Verification

28 findings were spot-verified by opening the cited files: `WorkspacesPage.tsx`, `PackageCard.tsx`, `TaskTemplateCard.tsx`, `RoomRow.tsx`, `button.tsx`, `FilterBarSort.tsx`, `eslint.config.js`, `collapsible.tsx`, `index.css` (border rule, `card-interactive`, dead keyframes), `badge.tsx`, `sheet.tsx`, `MobileTabBar.tsx`, `ActivityRow.tsx`, `trust-dial.tsx`, `QueuePanel.tsx`, `tasks/TaskRow.tsx`, `ActivityPage.tsx`, `TeamPage.tsx`, `input-otp.tsx`, `switch.tsx`, `link-safety-modal.tsx`, `CollapsibleCard.tsx`, `ConnectionStatusBanner.tsx` (relay shim), `settings/ToolsTab.tsx`, `widgets/tasks/TasksPage.tsx`, `TeamRosterToolbar.tsx`, plus counted greps for `border-<colour>` (69 files), `text-[Npx]` (203 hits / 76 files at `10px`), and `size-[--size-icon-*]` (2 files). All held except the one narrowed above.

---

## Batch 1 — Overflow containment

**Priority P1 · 7 findings · 6S · 1M**
**Scope:** every surface that renders a path, URL, id or long label without deliberate containment. One PR; the sweep item may split out.

The charter makes this automatic-P1: no content may escape its container or cause page-level horizontal scroll. All six concrete instances share one root cause — a long unbroken string in a flex row whose ancestors never got `min-w-0`, or a `truncate` applied to two siblings competing for the same space.

### 1.1 — Workspaces empty state: the workspace path escapes the card and the page

**P1 · S · lenses 8 + 11 (operator-confirmed)**
`apps/client/src/layers/widgets/workspaces/ui/WorkspacesPage.tsx:197-205`

**Evidence.** The "No worktrees yet" card interpolates the root path inline into body prose: ``{root ? ` in ${shortenHomePath(root)}` : ''}`` inside a plain `<p className="text-muted-foreground mt-1 text-sm">`. A filesystem path has no spaces, so the browser has no wrap opportunity. At 390×844 the string `~/Keep/dork-os/dorkos/apps/desktop/.temp/.dork/wo…` runs past the card's right edge and off the viewport, causing page-level horizontal scroll. Confirmed live by the operator with a screenshot, and independently reproduced by the mobile browser pass (`workspaces-phone.png`).

**Recommendation.** Simplest wins: drop the path from the sentence entirely — the folder is discoverable elsewhere on this page. If it stays, render it on its own line in a truncating element (`truncate` + `min-w-0` on every flex ancestor, full value on hover/tap) or use the shared `path-breadcrumb` primitive. Do not rely on `break-all` in running prose; it reads badly mid-sentence.

### 1.2 — Marketplace cards: author and source both crush to single characters, on all 303 cards

**P1 · S · lens 8**
`apps/client/src/layers/features/marketplace/ui/PackageCard.tsx:153-179`

**Evidence.** The metadata row renders `authorLabel` and `pkg.marketplace` as two siblings, each `min-w-0 truncate`, with only the separator and icons `shrink-0`. Flex distributes negative space in proportion to each item's _natural_ width, so both get crushed together. At 1440×900 with the right rail open, the featured rail reads `D... · dork...` and the 4-column grid reads `C... · d`. This is the default rendering for the whole catalogue, not an edge case. The component's own doc comment says this line exists so a reader "can tell a DorkOS package from a borrowed one"; today it cannot be read at all.

**Recommendation.** Reserve a floor for each side (`min-w-[3.5rem]`, or a fixed 60/40 basis split), or show one fact on narrow cards — author _or_ source — with the other in the detail sheet. Verify at the card width this grid actually produces at 1440px with the rail open, not at full bleed. Pairs with finding 2.2, which is the same grid measuring the wrong box.

### 1.3 — Command palette "Recent": the item's own name truncates harder than its path

**P2 · S · lens 8**
`apps/client/src/layers/entities/agent/ui/AgentOptionRow.tsx:49-70`

**Evidence.** ⌘K renders `Dork...  ~/Keep/dork-os/dorkos/apps/desktop/.temp/.dork/agents/dor...` — "DorkBot" (7 characters) cut to 4 while the secondary path shows ~55. `name` is `flex-auto` (grow 1, basis auto) and `secondary` is shrink-only. The inline comment at lines 51-59 explains the choice was to stop `name` vanishing against a 0-basis sibling, which it does — but proportional shrink means the short important label loses a large _fraction_ while the long path loses a large _absolute_ amount and still has room. The hierarchy inverts: the thing the user is scanning for is the thing that disappears.

**Recommendation.** Give `name` a floor it cannot cross before `secondary` yields more — `min-w-[8ch]` on the name span, or `shrink-0` on `name` plus a `max-w-*` cap on `secondary`. The path is provenance; it should yield first.

### 1.4 — Team card: "On this machine" truncates mid-word inside a card with room for it

**P2 · S · lens 8**
`apps/client/src/layers/features/team-roster/ui/TeamMemberCard.tsx:351`, `apps/client/src/layers/features/team-roster/ui/TeamRosterGrid.tsx:18`

**Evidence.** `/team` in Cards view at 1440×900 with a two-person roster renders the "You" card's secondary line as `On this ma...` — 16 characters cut well before the card's visible right edge. The class is `text-muted-foreground mt-1.5 truncate text-xs` at `md:grid-cols-2`; something upstream is starving the text column of width rather than the string being genuinely too long.

**Recommendation.** Measure the text column's computed width at `md` and find the fixed-width ancestor blocking it (a missing `min-w-0` is the usual culprit). This is a diagnosis-then-one-class fix, not a restyle.

### 1.5 — Settings → Appearance: the font description hard-clips mid-word with no ellipsis

**P3 · S · lens 8**
`apps/client/src/layers/features/settings/ui/tabs/AppearanceTab.tsx:63-71`

**Evidence.** The Font Family trigger shows "Inter + JetBrains Mor" — the intended string (`font-config.ts:39`) is "Inter + JetBrains Mono". `SelectTrigger className="w-40"` (160px) is too narrow for the stacked value plus description, and the description span carries no `truncate`/`overflow-hidden`, so the browser clips at the container edge mid-character with no ellipsis.

**Recommendation.** Add `truncate` to the description span so it degrades to `…`, or widen the trigger. Clipping without an ellipsis reads as a rendering bug, not as a design decision.

### 1.6 — Marketplace search placeholder clips on phone; the `/` hint it makes room for is meaningless on touch

**P2 · S · lens 8**
`apps/client/src/layers/features/marketplace/ui/MarketplaceToolbar.tsx:165-177`

**Evidence.** At 390×844 the placeholder renders as "Search packag" with no ellipsis. The input reserves `pl-9` for the icon and `pr-10` for a `<kbd>/</kbd>` shortcut badge, inside a field already sharing the row with a `w-32 shrink-0` sort `Select`. A touchscreen has no keyboard-shortcut context, so the badge eats width from the one string every visitor needs to read.

**Recommendation.** Charter adaptive strategy (c) — hide the `<kbd>` below the `isMobile` breakpoint. That alone reclaims enough width for the full placeholder at 390px without touching the `Select`.

### 1.7 — Sweep: every path, URL and id render needs deliberate containment

**P1 · M · lens 8 (operator-directed)**
Pattern, app-wide. Known instances: 1.1 above; `AgentOptionRow.tsx` (1.3); session ids and branch names throughout `entities/session`, `features/workspaces`, `features/relay`.

**Evidence.** The codebase renders many unbroken strings inline. Any of them can blow out a container on a narrow screen; two already do. The shared primitives that solve this (`shared/ui/path-breadcrumb.tsx`, `shared/ui/truncated-output.tsx`) exist and are under-used.

**Recommendation.** Sweep every render of a path, URL, session id or branch name. Contain each with `path-breadcrumb`/`truncated-output` where they fit, or `truncate` + `min-w-0` on the flex ancestors. Add a browser assertion that the page body never scrolls horizontally at 390px on each main route, so the class of defect cannot regrow.

---

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

---

## Batch 3 — Keyboard and screen-reader gaps

**Priority P1 · 5 findings · 4S · 1M**
**Scope:** controls that are reachable but unusable by keyboard, or that speak the wrong thing. Two shared primitives, one feature card, two sweeps.

### 3.1 — `FilterBarSort`'s direction toggle is keyboard-unreachable, nested inside another button

**P1 · S · lenses 2 + 9**
`apps/client/src/layers/shared/ui/filter-bar/FilterBarSort.tsx:37-61`

**Evidence.** Verified in source. Inside `DropdownMenuTrigger` — which Radix renders as a real `<button>` — sits a `<span role="button" tabIndex={-1}>` carrying `onClick`, a full Enter/Space `onKeyDown`, and an `aria-label`. Two defects compound: (a) a button nested in a button is invalid HTML that browsers unnest unpredictably; (b) `tabIndex={-1}` means focus can never land there, so the `onKeyDown` it carries can never fire, and the Enter/Space that does reach the trigger is consumed by Radix to open the menu. **Reversing a sort has no keyboard path at all**, on a shared control backing the toolbars of `/tasks`, `/team` and `/activity`.

**Recommendation.** Split the controls. Render the trigger with `asChild` over `<Button variant="outline" size="xs">` for "Sort: {label}", and put the direction toggle _beside_ it as its own `<Button variant="ghost" size="icon-xs" aria-label=…>` sibling. Both then get a real tab stop, the shared focus ring, and the responsive touch height.

### 3.2 — Schedule template cards speak the entire prompt as the button's accessible name

**P1 · S · lens 9**
`apps/client/src/layers/features/tasks/ui/TaskTemplateCard.tsx:58-97` (line 95 specifically)

**Evidence.** Playwright's accessibility snapshot on `/tasks` shows each preset button's accessible name is name + description + cron + the **entire** prompt, e.g. _"activity-summary Summarize recent agent activity across all sessions Every weekday at 6:00 PM Summarize today's agent activity: 1. List sessions that were active today 2. Note any errors or failures 3. Highlight completed tasks…"_. The prompt is rendered with `line-clamp-2`, which is visual-only — the full text stays in the DOM and joins the enclosing `<button>`'s name because nothing overrides it. A screen-reader user tabbing this list hears the whole paragraph, four times.

**Recommendation.** Give the button a concise `aria-label` (`` `${preset.name}: ${preset.description}` ``) and mark the cron line and prompt preview `aria-hidden`. Never let visually-truncated content still speak in full.

### 3.3 — `LinkSafetyModal` claims `aria-modal` without focus trap, focus restore, scroll lock or working Escape

**P1 · M · lens 2**
`apps/client/src/layers/shared/ui/link-safety-modal.tsx:52-125`; compare `apps/client/src/layers/shared/ui/dialog.tsx:27-48`

**Evidence.** Verified in source. The app's single link-confirmation surface — reached from every markdown link in every answer, from gen-UI `url` actions and from MCP App iframes — is a bare `createPortal` into `document.body`: a `<div className="fixed inset-0 …">`, an `aria-hidden` backdrop `<div onClick={onClose}>`, and a `<div role="dialog" aria-modal="true" tabIndex={-1} onKeyDown={…}>`. Nothing ever calls `.focus()` on the container and there is no `autoFocus`, so a keyboard user who activates a link keeps focus on the anchor **behind** the overlay: Escape never reaches the handler, Tab walks the page underneath, and there is no scroll lock or focus restore. `aria-modal="true"` is a claim the markup does not keep. The file's own docblock justifies only the _portalling_ ("to escape transform-based containing blocks"), which `DialogPortal` also provides; nothing in `decisions/` requires a hand-rolled dialog here.

**Recommendation.** Re-express as `<Dialog open onOpenChange>` + `<DialogContent>` with `DialogTitle`/`DialogDescription` carrying the `title`/`detail` strings it already computes, keeping the `LinkSafetyModalProps` signature unchanged so the three call sites do not move. The three hand-rolled buttons become `<Button>`s (see 14.5). No visual change intended — the same box, with the behaviour it already claims.

### 3.4 — Hand-rolled controls fall back to Chromium's native focus ring

**P2 · S · lens 9**
`apps/client/src/layers/features/right-panel/ui/RightPanelHeader.tsx:260-277`, `apps/client/src/layers/features/status/ui/RuntimeItem.tsx:180`, `ModelConfigPopover.tsx:225`, `PlanModeItem.tsx:42`, `PermissionModeItem.tsx:162`, `apps/client/src/layers/features/tasks/ui/TaskTemplateCard.tsx:64-72`, `apps/client/src/layers/features/mesh/ui/AdapterNode.tsx:154-168`

**Evidence.** Verified live by real `Tab` traversal, not static reading. Focusing the `/session` right-panel "Files" tab and reading `getComputedStyle(document.activeElement)` returns `outline: auto 1px rgb(0, 95, 204)` — Chromium's native blue, not the app's `focus-visible:ring-ring/50 ring-[3px]`. The adjacent "Close panel" icon button shows the custom ring correctly, so the contrast is visible in one screenshot. `RightPanelHeader` re-implements a tab strip from bare `<button role="tab">` instead of reusing `shared/ui/tabs.tsx:26-42`, which already gets this right (confirmed on the Marketplace Browse/Installed toggle). The four `status/ui/*` files each hand-copy the identical class string `'hover:text-foreground inline-flex min-w-0 … transition-colors duration-150'` with no focus treatment. `TaskTemplateCard`'s `cn()` (verified) has `hover:bg-accent/50` and no `focus-visible:` anywhere. `AdapterNode`'s "Add adapter" ghost node has `hover:opacity-70` and no focus twin despite being `role="button" tabIndex={0}` with an Enter/Space handler.

**Recommendation.** For the right-panel strip, adopt the shared `Tabs`/`TabsTrigger` primitive. For the four `status/ui/*` files, extract the duplicated string into one shared constant and add `focus-visible:ring-ring/50 focus-visible:ring-[3px]` once. For `TaskTemplateCard` and `AdapterNode`, add the `focus-ring` utility from `index.css`. Keyboard users currently lose the app's focus language on exactly the surfaces that gate real actions.

### 3.5 — Bare `focus:` rings in five shared primitives fire on mouse click

**P2 · S · lens 2**
`apps/client/src/layers/shared/ui/badge.tsx:6`, `dialog.tsx:41`, `sheet.tsx:76`, `responsive-dialog.tsx:223`, `select.tsx:23`

**Evidence.** Verified in source — `badge.tsx` carries `focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2`, `sheet.tsx`'s close button `focus:ring-2 focus:ring-offset-2 focus:outline-hidden`. `.claude/rules/components.md` §Required Patterns is explicit: "**Focus styles**: `focus-visible:` (keyboard only), never bare `focus:`." Everything else in the folder already complies. A bare `focus:` ring paints on every mouse click — chrome at rest, which `design-system.md` §Anti-Patterns rules out — and it is a path-rule violation, binding under Hard Rule 8.

**Recommendation.** Mechanical swap to `focus-visible:` in those five class strings. The dialog and sheet close buttons should become `<Button variant="ghost" size="icon-sm" asChild>` per 14.5, which fixes them for free.

---

## Batch 4 — Tokens that don't paint

**Priority P1 · 9 findings · 5S · 2M · 2L**
**Scope:** the design tokens exist, are correct, and are not what the app actually renders. The first two items are large sweeps and want their own PRs; the rest fit one slice each.

### 4.1 — `border-<colour>` renders as the neutral border on 69 files

**P1 · M · lens 1**
`apps/client/src/index.css:673-675`; 69 affected files including `layers/features/mesh/ui/DiscoveryView.tsx:262,322`, `layers/features/settings/ui/TunnelDialog.tsx:207-209`, `layers/features/tasks/ui/TaskTemplateCard.tsx:70`, `layers/features/chat/ui/chips/TouchChip.tsx:148,178`, `layers/features/marketplace/ui/PackageTypeBadge.tsx:10-14`, `layers/features/gen-ui/ui/nodes/TimelineNode.tsx:22-23`

**Evidence.** Verified in source:

```css
*:where(:not(.copilot-view-content *)) {
  border-color: hsl(var(--border));
}
```

This rule is **unlayered**. Tailwind v4 generates every utility inside `@layer utilities`, and per the cascade-layers spec an unlayered normal-priority declaration always beats a layered one regardless of specificity — so this near-zero-specificity universal rule outranks every coloured border utility in the app. `contributing/design-system.md:602` documents the exact mechanism and states it was "verified in a browser". What this audit adds is the blast radius: **69 files** (counted) still write a `border-<colour>` expecting it to render. `TunnelDialog` switches between `border-amber-400/40`, `border-destructive/40` and neutral on tunnel state — three states meant to look different at a glance, rendering identically. `TaskTemplateCard`'s `border-primary` selected state does not paint. This is dead styling shipping in production, and the count keeps growing because the obvious Tailwind class is a trap.

**Recommendation.** Treat as Hard-Rule-adjacent, not polish. Do the layering fix the doc already calls for — move the `*:where(…)` rule into a layer below `utilities`, or scope it narrowly enough that it stops shadowing colour utilities — then visually re-review. That fixes all 69 sites at once, which is the Calm-Tech-correct answer over 69 component patches. If the layering fix must be deferred, add an ESLint rule banning `border-<colour>` outside `shared/ui` so the count stops growing.

### 4.2 — Arbitrary `text-[Npx]` bypasses the type ramp and the mobile scale — 203 hits

**P1 · L · lenses 1 + 8**
`apps/client/src/index.css:87-90` (the tokens); 203 occurrences across ~100 files, 76 files at `text-[10px]` alone. In `shared/ui` itself: `kbd.tsx:8`, `trust-dial.tsx:423`, `provenance-chip.tsx:85`, `identity-hover-card.tsx:96,332`, `responsive-dropdown-menu.tsx:232,322`, `sidebar-row.tsx:191,555`, `section-header.tsx:187,214`

**Evidence.** Counted by grep. `index.css` defines two sub-`text-xs` tokens specifically so nothing has to drop to a raw pixel value:

```css
--text-3xs: calc(0.625rem * var(--_st) * var(--user-font-scale, 1)); /* 10px → 12.5px mobile */
--text-2xs: calc(0.6875rem * var(--_st) * var(--user-font-scale, 1)); /* 11px → 13.75px mobile */
```

Both multiply by `--_st`, the mobile-scale multiplier, and by the user's own font-scale setting. An arbitrary-bracket value compiles to a literal, unscaled `font-size` that participates in neither. So most of the app's finest-grained text — timestamps, badges, kbd hints, legends, mesh node chips, model pickers — is exempt from the responsive type-scale contract the design system advertises, and two visually identical 10px labels in adjacent components scale differently on a phone. `text-[9px]` (10 hits, e.g. `AttentionCountBadge.tsx:39`, `BindingEdge.tsx:165,170`) is below the whole ramp with no token at all.

**Recommendation.** Mechanical replace: `text-[10px]` → `text-3xs`, `text-[11px]`/`text-[0.6875rem]` → `text-2xs`. Start with the `shared/ui` primitives listed above — one change propagates everywhere `Kbd`/`ProvenanceChip`/`IdentityHoverCard`/`ResponsiveDropdownMenu` are used. The `text-[9px]` sites need a decision first: a real `text-4xs` token, or a bump to `text-3xs`. Legitimate exceptions stay literal and should be commented: `kbd.tsx` if shortcut hints are deliberately desktop-only, and the `text-[13px]`/`text-[17px]` iOS-HIG values in `responsive-dropdown-menu.tsx`. Add a lint rule banning `text-\[[0-9]+px\]` outside `dev/` once the backlog clears.

### 4.3 — The documented icon-size convention has two adopters against 141 files

**P2 · L · lens 1**
`apps/client/src/index.css:98-100`, `apps/client/src/layers/shared/ui/button.tsx:8`; adopters: `layers/features/shapes/ui/ShapeSwitcherDialog.tsx`, `ShapeForkForm.tsx` (verified — exactly these two files)

**Evidence.** `index.css` defines a three-step icon scale multiplying by `--_si` (12→15px, 16→20px, 20→25px on mobile), and `design-system.md`'s Icon Size Convention says "use `size-[--size-icon-*]` for all icon sizing". Verified: **two files** use it, both in one feature slice. Elsewhere icons are sized with plain `size-4` (141 files), and `button.tsx:8` bakes `[&_svg:not([class*='size-'])]:size-4` in as the default for every unsized `<svg>` inside a `Button` — so the majority of icon-bearing buttons inherit the non-scaling default before a call site can opt in. On desktop the two are visually identical, which is why the drift went unnoticed; below 768px the convention grows icons 25% and the codebase does not.

**Recommendation.** Decide, then finish. Either (a) confirm the convention and migrate `shared/ui` defaults first — starting with `button.tsx`'s default rule, which fixes icon scaling for every button in one place — or (b) retire the doc section and the two adopting files. Do not leave both states shipping side by side.

### 4.4 — Status colour is spelled seven ways across relay, status, tasks, top-nav and `shared/ui`

**P2 · M · lenses 1 + 3 + 12**
Intended source: `apps/client/src/layers/shared/ui/status-dot.ts`. Divergent: `layers/entities/relay/lib/adapter-state-colors.ts:12-19`, `layers/features/relay/lib/status-colors.ts:2-62`, `layers/features/relay/ui/MessageTrace.tsx:9-26`, `layers/features/relay/ui/RelayHealthBar.tsx:18-22`, `layers/features/tasks/ui/TaskRow.tsx:72-82`, `layers/features/status/ui/ConnectionItem.tsx:30,37,44,59,113`, `layers/features/top-nav/ui/SystemHealthDot.tsx:7-8`, `layers/entities/session/ui/SessionContextGauge.tsx:12-13`, `layers/features/status/ui/ContextItem.tsx:48`, `layers/shared/ui/ConnectionStatusBanner.tsx:38-39`, `layers/shared/ui/provenance-chip.tsx:87,129`

**Evidence.** `status-dot.ts`'s own module doc records the original bug: _"a green that was `bg-green-500` in the sidebar, `bg-emerald-500` in an agent panel, `bg-status-success` in a room and `bg-primary` in a group header — four spellings of one fact… This module is the spelling."_ That fix reached identity and sidebar surfaces and stopped. Verified in source: `tasks/TaskRow.tsx`'s `StatusDot` still returns `'bg-yellow-500'` / `'bg-neutral-400'` / `'bg-green-500'` — raw palette, no tokens, no `statusDotClass` — while `RoomRow.tsx:413`, `SessionSwitcher.tsx:423` and `SessionRowSidebar.tsx:248` all call it correctly. Relay independently grew four more maps, including `RelayHealthBar`'s `healthy: 'bg-emerald-500'` against `status-colors.ts`'s `healthy: 'bg-green-500'` — the exact green-versus-emerald drift the doc names as the original bug, reproduced inside one feature. `MessageTrace` adds `bg-slate-400` and `bg-yellow-500`, colours in none of the other maps. `adapter-state-colors.ts` even hand-types `motion-safe:animate-pulse`, duplicating `STATUS_DOT_PULSE` verbatim rather than importing it. Two of the offenders are `shared/ui` primitives, and `ConnectionStatusBanner` hand-writes `dark:` variants doing by hand what `--status-error-fg`/`--status-warning-fg` already do.

**Recommendation.** Extend `StatusSignal`/`STATUS_DOT_COLOR` (or add a thin relay adapter mapping `starting`/`reconnecting`/`no_subscriber`/`timeout` onto the four semantic tokens plus a neutral) so all of these resolve through the one vocabulary. Delete `adapter-state-colors.ts`, `status-colors.ts` and the two inline maps once callers are re-pointed. Migrate the text/banner tints to `text-status-*-fg`/`bg-status-*-bg`, which deletes every hand-written `dark:` variant in the process. This is the repo's own three-strike DRY rule at seven strikes.

### 4.5 — `TASK_COLORS` re-implements the app's categorical palette with fixed, non-theme-tuned literals

**P2 · S · lens 1**
`apps/client/src/layers/features/chat/model/use-background-tasks.ts:24-29`; compare `apps/client/src/index.css` `--chart-1..5` (`:404-408` light, `:493-497` dark) and `layers/features/gen-ui/ui/nodes/ChartNode.tsx:21-25`

**Evidence.** `--chart-1..5` exists as the app's answer to "N mutually distinguishable colours for same-kind items", and is deliberately tuned per theme (`--chart-3: 152 60% 36%` light vs `152 55% 50%` dark). `use-background-tasks.ts` has the identical need — a stable colour per concurrently-running background task — and hard-codes five `hsl(...)` literals identical in light and dark.

**Recommendation.** Replace `TASK_COLORS` with `hsl(var(--chart-1))`…`hsl(var(--chart-5))`. If the hues genuinely need to differ, add `--task-chart-*` tokens in `index.css` with light/dark variants rather than literals in a `.ts` model file.

### 4.6 — Terminal hardcodes its font stack, so a user's font override never reaches it

**P2 · S · lens 1**
`apps/client/src/layers/features/terminal/ui/TerminalInstance.tsx:135-136`; compare `:329-332` (`readTerminalTheme`)

**Evidence.** The component already derives the terminal's background and foreground from `getComputedStyle(container)` specifically so it "matches the active (light/dark) theme", per its own doc comment. It does not extend that to the font: xterm's `fontFamily` is a literal `'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'`. `design-system.md`'s Typography section: _"Users can override font family via Settings → Appearance… Avoid hardcoding specific font names in component styles."_ So a custom monospace font appears in every code block and message but not in the terminal.

**Recommendation.** Read `--font-mono` off `getComputedStyle(container).fontFamily` at the same point `readTerminalTheme` runs, and pass it into the `Terminal` constructor. xterm needs a resolved string at construction, so this cannot be a class name.

### 4.7 — `ExecutionExceptionsStrip` falls back to a raw `#888` instead of the identity resolver

**P3 · S · lens 1**
`apps/client/src/layers/features/settings/ui/runtimes/ExecutionExceptionsStrip.tsx:112`

**Evidence.** `<AgentAvatar color={agent.color ?? '#888'} …>`. Every other `AgentAvatar` call site (`SidebarModelRow.tsx:359`, `SessionSwitcher.tsx:282`, `AgentListItem.tsx:200`) passes `visual.color` from `useAgentVisual`, which resolves through `resolveIdentityFace` — the function that hashes a deterministic colour from the agent's id precisely so a colourless agent still reads as _an_ identity rather than flat grey. This is the one production site that skips it, for the exact case the resolver exists to handle.

**Recommendation.** Resolve `agent.color` through `useAgentVisual`/`resolveIdentityFace` like the other three call sites.

### 4.8 — Off-grid indentation paddings copy-pasted across sibling components

**P3 · S · lens 1**
`pl-[18px]` in `layers/features/relay/ui/adapter/AdapterCardError.tsx:21`, `AdapterCardBindings.tsx:58`, `AdapterCardHeader.tsx:95`; `pl-[1.375rem]` in `layers/features/settings/ui/runtimes/RuntimeCard.tsx:564`, `layers/entities/runtime/ui/RuntimeSetupDialog.tsx:557`

**Evidence.** `design-system.md`'s Spacing section: "All spacing values are multiples of 4px." 18px and 22px are not, and each is copy-pasted across multiple files rather than defined once — so the codebase has committed to them as if they were tokens without making them one. Both are visually chasing the same thing: aligning a caption under a leading icon.

**Recommendation.** If "indent a caption under a leading icon" is a real recurring need, give it a shared utility or an `--indent-under-icon` custom property. At minimum land both on the 4px grid (`pl-4`/`pl-5`, `pl-5`/`pl-6`) so they are expressible as standard utilities.

### 4.9 — `NewMenu` uses `text-[12px]` where `text-xs` is the same value

**P3 · S · lens 1**
`apps/client/src/layers/features/dashboard-sidebar/ui/NewMenu.tsx:394`

**Evidence.** `text-xs` is 12px on the desktop base scale. This is the only `text-[12px]` in the non-test, non-`dev/` codebase — an isolated redundancy, unlike the systemic 10px/11px pattern in 4.2 — and it still loses the mobile-scale multiplier.

**Recommendation.** `text-[12px]` → `text-xs`. Fold into the 4.2 sweep.

---

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

---

## Batch 6 — Rows and cards missing their own states

**Priority P2 · 8 findings · 8S**
**Scope:** feature-level rows and page-level query states. All single-file class or branch additions; no shared primitive changes. Good parallel work alongside batch 5.

### 6.1 — `SessionRowFull` has no hover state; `SessionRowCompact` does

**P2 · S · lens 9**
`apps/client/src/layers/entities/session/ui/SessionRowFull.tsx:100-139`; compare `SessionRowCompact.tsx:94-98`

**Evidence.** The clickable `motion.div` (`role="button" tabIndex={0}`) carries `'relative z-10 cursor-pointer px-3 py-2'`, and its wrapper is `cn('group relative rounded-lg border-l-2 transition-colors duration-150', isActive && 'text-foreground')` — no `hover:` anywhere in the file outside the nested edit/expand icon buttons, which are themselves `group-hover` opacity-gated. Its sibling one prop away has `isActive ? '…' : 'text-muted-foreground hover:bg-accent hover:text-foreground'`. This is the charter's named case: one row highlights on hover, its sibling does not. Both render real sessions (`SessionsView`, `SessionPopover`).

**Recommendation.** Add a `hover:bg-secondary/60` background to the non-active branch of the outer `motion.div`, matching `SessionRowCompact`'s treatment.

### 6.2 — `tasks/TaskRow`'s primary click target has no hover or focus feedback, unlike its own nested buttons

**P2 · S · lens 9**
`apps/client/src/layers/features/tasks/ui/TaskRow.tsx:169-174`

**Evidence.** The card header — `role="button" tabIndex={0}`, toggles expand/collapse, the row's main interaction — has `'flex cursor-pointer items-center gap-3 p-3'` as its _entire_ className: no `hover:`, no `focus-visible:`. Every action button _inside_ the same card (Approve, Reject, Edit, Delete at lines 254, 260, 268, 288, 299, 368, 374) carries full `hover:bg-accent hover:text-accent-foreground … transition-colors`. The region a user is most likely to click is the one with zero affordance.

**Recommendation.** Add `hover:bg-accent/50 focus-visible:bg-accent/50 transition-colors` (or the `focus-ring` utility) to the row's className.

### 6.3 — `chat/ui/tasks/TaskRow`'s subtask row has no hover or focus state anywhere in the file

**P2 · S · lens 9**
`apps/client/src/layers/features/chat/ui/tasks/TaskRow.tsx:52-70`

**Evidence.** A `role="button" tabIndex={0}` row whose `onMouseEnter`/`onMouseLeave` are wired only to a cross-row dependency-highlight callback, not to its own visual state. A grep of the whole file for `hover:` and `focus-visible` returns zero. The className varies by `task.status` and by dependency-highlight state, never by pointer-hover or keyboard-focus on itself — so a keyboard user tabbing a task list has no indication which row Enter will activate.

**Recommendation.** Add a `hover:bg-muted/40` tint (the documented 5-10% step) plus a `focus-visible:` twin.

### 6.4 — `ActivityPage` never surfaces a fetch error; a failed request looks like a quiet week

**P2 · S · lens 9**
`apps/client/src/layers/widgets/activity/ActivityPage.tsx:32-33`, `apps/client/src/layers/widgets/activity/ui/ActivityTimeline.tsx:95-129`

**Evidence.** Verified in source: `ActivityPage` destructures `{ data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage }` — **no `isError`** — and `ActivityTimeline` branches only on `isLoading` and `items.length === 0`. If the query fails, `allItems` is `[]` and the page renders `ActivityEmptyState`: the same UI a genuinely quiet week produces. A backend problem is indistinguishable from "you haven't done anything." This is a regression from the app's own established pattern — `AccountsRegion.tsx:45-58`, `TeamPage.tsx:114-131` (verified: explicit `isError` branch, "Could not load your team" + Retry), `FeedbackRequestsPanel.tsx:140-161` and `InboxList.tsx:136` all handle it.

**Recommendation.** Thread `isError`/`refetch` out of `useFullActivityFeed` and add an error branch matching the retry pattern already standard elsewhere. Pairs with 17.2, which extracts that pattern into one component.

### 6.5 — `TeamPage` loads with a bare spinner, not a layout-matching skeleton

**P2 · S · lens 9**
`apps/client/src/layers/widgets/team/ui/TeamPage.tsx:103-112`; compare `apps/client/src/layers/features/marketplace/ui/PackageLoadingSkeleton.tsx:1-39`, `apps/client/src/layers/features/dashboard-sidebar/ui/boot/SidebarSkeleton.tsx:1-48`

**Evidence.** Verified in source: the loading branch is a centred `Loader2` spinner with no card or grid shape. When data arrives the page pops from an empty centred dot to a full `grid-cols-1 md:grid-cols-2 xl:grid-cols-3` of `TeamMemberCard`s — the largest layout jump this pattern can produce. The app's own precedent is explicit: `PackageLoadingSkeleton`'s doc comment says "The card structure mirrors `PackageCard` dimensions so the layout does not jump when real data arrives", and `SidebarSkeleton`'s says "It reserves, it does not entertain… at exactly the geometry the real panel uses." Team is the same shape of problem and got the plainer treatment.

**Recommendation.** Add a `TeamRosterSkeleton` mirroring `TeamMemberCard`'s dimensions in the same grid, following `PackageLoadingSkeleton`.

### 6.6 — Dashed border means "not available yet" and "live and serving" on the same page

**P2 · S · lens 9**
`apps/client/src/layers/features/relay/ui/adapter/AdapterCard.tsx:104-114`; compare `apps/client/src/layers/features/connections/ui/AccountsFirstRun.tsx:57`

**Evidence.** On `/connections`, the Accounts section's Gmail/GitHub/Linear/Notion/Slack preview cards use `border border-dashed` to mean "not yet connectable — no Composio key configured", and the Marketplace `?view=installed` empty state uses the same convention for "No packages installed". But the **live, enabled, actively-serving** Claude Code adapter directly above also renders dashed — `isBuiltinClaude && 'border-dashed'`, with no comment explaining why — with a green active dot, a toggled-on switch and "Serving 1 agent" inside a box that everywhere else on the same screen means "this doesn't exist yet."

**Recommendation.** Drop the special-cased dashed border for the built-in adapter; it already carries an "internal" badge. If a distinction is still wanted, use something that does not collide with the empty/unavailable convention — a muted label, not a border style.

### 6.7 — `ScrollThumb`'s draggable thumb has no hover affordance

**P3 · S · lens 9**
`apps/client/src/layers/features/conversation/ui/ScrollThumb.tsx:140-158`

**Evidence.** The thumb is `cursor-pointer` and draggable via `onPointerDown`, but only changes `opacity` based on scroll activity, never in response to `:hover`. A user moving the pointer toward it to grab it gets no cue distinguishing it from decorative scroll-position chrome; the track has no hover treatment either.

**Recommendation.** Add `hover:bg-foreground/40` over the current `bg-border` on the thumb, matching the 5-10% tint-step convention.

### 6.8 — The composer's ring never changes between idle and focused

**P3 · S · lens 9**
Message composer container, rendered on `/` and `/session`; class chain confirmed live via `getComputedStyle`

**Evidence.** The composer's outer container renders `border-ring ring-ring/75 ring-[1px]` unconditionally — not `focus-within:`-gated. Computed box-shadow resolves to the `--ring` token (`hsl(24 88% 55%)`), the same orange the rest of the app reserves for `focus-visible`. Because the composer wears it permanently, a keyboard user tabbing into and away from it sees no change: it looks focused whether or not it is. (Noted, not filed: the composer also auto-focuses on every page load, a defensible chat convention, but it means a keyboard user's first stop is the message box rather than the nav.)

**Recommendation.** Reserve the orange ring for the composer's actual `:focus-within` state with a quieter idle border, so focus is legible there as it is everywhere else.

---

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

---

## Batch 8 — Copy: honesty and settled vocabulary

**Priority P1 · 7 findings · 4S · 2M · 1L**
**Scope:** strings that misdescribe risk, or that name one concept several ways. 8.3 is spec-sized (~40 render-path strings plus test-id assertions); the rest are sweeps within one feature each. Identifiers, routes and schemas stay untouched throughout — this is display copy only, exactly as ADR `260804-021140` splits it.

### 8.1 — The riskiest permission setting describes itself like the safe one

**P1 · S · lens 7**
`apps/client/src/layers/shared/ui/trust-dial.tsx:100-109` (rendered at `:339`), `apps/client/src/layers/shared/ui/unattended-autonomy-dialog.tsx:96`, `apps/client/src/layers/features/status/ui/AutonomyConfirmDialog.tsx:167`, `apps/client/src/layers/shared/ui/consent-ritual-copy.ts:66`

**Evidence.** Verified in source. Two adjacent stops:

- `act` (`asks: 'when-risky'`) — `"Gets on with the work and stops for the risky parts."`
- `autonomy` (`asks: 'never'`) — `"Acts without stopping for approval — still asks when it matters."`

Read cold, those say the same thing: _it works on its own and asks about the risky bits_. The machine claims are opposites. The dial renders `current.promise` directly under the segmented control, and the same sentence is what `UnattendedAutonomyDialog` shows as its `AlertDialogDescription` — the consent moment for an agent that will act unattended. `consent-ritual-copy.ts:66` deliberately withholds the honest line (`"This stop never pauses to ask. Whatever it decides to do, it does."`) at exactly this stop, reasoning that "the title is the promise" — but the title is only the two words "Full autonomy", and the sentence under it walks the promise back. AGENTS.md: "Be honest by design: no dark patterns." The one caption where understating risk costs the user something is the one that understates it. It also carries an em dash, against the house rule.

**Recommendation.** Replace the autonomy `promise` with a sentence that names the difference and carries no hedge: `"Acts on its own. It will not stop to ask you, even for risky steps."` Keep `FullPowerDoor.tsx:54`'s longer nuance where there is room; a 60-character dial caption is not that place. Then reconsider whether `consentAsksNote` should still return `null` for autonomy once the title's sentence is honest.

### 8.2 — Words an accepted ADR retired from user-facing copy are still on screen

**P1 · M · lens 7**
`apps/client/src/layers/features/relay/ui/RelayEmptyState.tsx:63,66,70`, `layers/features/mesh/ui/AdapterNode.tsx:168,171`, `layers/entities/binding/ui/BindingDialog.tsx:280,296`, `layers/features/relay/ui/wizard/ConfirmStep.tsx:42`, `layers/features/relay/ui/adapter/AdapterCardHeader.tsx:64`, `layers/features/agent-settings/ui/ContextTab.tsx:207-208`, `layers/features/agent-settings/ui/ToolsTab.tsx:419-420`, `layers/features/marketplace/ui/MarketplaceSidebar.tsx:206`, `layers/entities/runtime/config/runtime-descriptors.ts:80`

**Evidence.** ADR `260804-021140` (accepted, current, "this is the last rename") retires `integration`, `connector`, `adapter` and `provider` as user-facing nouns. All four are still rendered:

| Current string                                                                                                                                                | File                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `Add Integration`, `Relay routes messages between your agents and external platforms.`, `Add your first integration to start sending and receiving messages.` | `RelayEmptyState.tsx:70,63,66`        |
| `Add Adapter` / `aria-label="Add adapter"`                                                                                                                    | `AdapterNode.tsx:171,168`             |
| `<Label>Adapter</Label>`, `placeholder="Select an adapter"`                                                                                                   | `BindingDialog.tsx:280,296`           |
| `Adapter ID`                                                                                                                                                  | `wizard/ConfirmStep.tsx:42`           |
| `aria-label="Adapter actions"`                                                                                                                                | `AdapterCardHeader.tsx:64`            |
| `label="Adapter Tools"` / `"External platform subjects, adapter management, and binding routing conventions."`                                                | `ContextTab.tsx:207-208`              |
| `label: 'External Integrations'` / `'Manage integrations with Slack, Telegram, and other platforms'`                                                          | `agent-settings/ToolsTab.tsx:419-420` |
| `label="Connectors"` (marketplace facet)                                                                                                                      | `MarketplaceSidebar.tsx:206`          |
| `subtitle: 'Your own models, local or any provider'`                                                                                                          | `runtime-descriptors.ts:80`           |

Meanwhile the same feature's toasts already speak the new vocabulary — `IntegrationsTab.tsx:124,153,166` fire `'Connection added'`, `'Connection removed'`, `'Connection paused'`. One screen calls the thing four names. `scripts/check-vocab-gate.ts` exists to stop exactly this and has only shipped Wave 1 ("connection"); its own header names these four as the planned Wave 2, which never landed.

**Recommendation.** Sweep to the ADR's vocabulary — **Connections** (umbrella), **Messaging** (the Relay region), **Accounts** (the ConnectorProvider region). Concretely: `Add Integration` → `Add a connection`; `Relay routes messages between…` → `Connections let people and platforms reach your agents.`; `Add Adapter` → `Add a connection`; `Adapter`/`Adapter ID` → `Connection`/`Connection ID`; `Adapter Tools` → `Connection tools`; `External Integrations` → `Connections`; the marketplace facet `Connectors` → `Connections`; `or any provider` → `or any service`. Then ship Wave 2 of `vocab-gate/banned-terms.json` so it cannot come back.

### 8.3 — One thing, three names: session vs conversation vs chat

**P2 · L · lens 7**
Representative: `layers/features/session-list/ui/SessionsView.tsx:86`, `EmbedSessionList.tsx:99`, `layers/features/chat/ui/ChatEmptyState.tsx:60`, `layers/features/command-palette/ui/AgentSubMenu.tsx:105,110`, `layers/features/dashboard-sidebar/model/rules/build-getting-started.ts:54`, `layers/features/dashboard-sidebar/ui/SessionSwitcher.tsx:191,299`, `layers/features/settings/ui/runtimes/GlobalTrustRow.tsx:123`, `layers/features/settings/ui/runtimes/rows/ModelRow.tsx:92`, `layers/features/onboarding/ui/SystemRequirementsStep.tsx:472,528`, `layers/features/canvas/ui/CanvasFileContent.tsx:110`, `layers/features/status/ui/UsageStatusItem.tsx:69,159`, `layers/features/profile/ui/pages/SessionsPage.tsx:88,103,110`, `layers/features/status/ui/SessionPopover.tsx:140`

**Evidence.** The same object — one working thread with one agent — carries three names, sometimes in one dropdown:

- **conversation**: `"No conversations yet"`, `"Start a conversation"`, `"Where new conversations stop for you"`, `"Couldn't branch off this conversation."`, `"Search conversations"`
- **session**: `"New Session"` and `"Browse sessions…"` in the same menu (`AgentSubMenu.tsx:105` and `:110`), `"Start your first session"`, `"Open a session to view files."`, `"Session Cost"`, `"Session Strategy"`
- **chat**: `"Start new chats with"` (onboarding), `"New chats will start with it."` (the very next sentence a first-run user reads)

Onboarding teaches "chats". The Getting-started checklist immediately says "Start your first session". The empty state that follows says "Start a conversation". A newcomer to agents has to build one mental model and is handed three labels for it inside the first two minutes.

**Recommendation.** Pick one and write it into a short ADR so the next PR inherits it. **"Chat"** is the recommendation: shortest, least technical, already used by onboarding, and it collides with nothing (`channel` is claimed by ADR `260726-193526`; `session` is a load-bearing wire/API noun that should stay in code and out of copy). Then sweep: `"No conversations yet"` → `"No chats yet"`; `"New Session"` → `"New chat"`; `"Start your first session"` → `"Start your first chat"`; `"Session Cost"` → `"Chat cost"`; `"Open a session to view files."` → `"Open a chat to see its files."`. Add a Wave-3 entry to `vocab-gate/banned-terms.json` for the two losers. Effort is **L** because it touches ~40 render-path strings plus the deep-link and test-id assertions that quote them.

### 8.4 — "Task", "schedule" and "run" name one thing inside one screen

**P2 · S · lens 7**
`apps/client/src/layers/widgets/tasks/ui/TasksPage.tsx:75`, `layers/features/tasks/ui/TasksList.tsx:99,123`, `TaskFormInner.tsx:306,326,345,366,624`, `TaskRunHistoryPanel.tsx:390-392,427`, `layers/features/onboarding/ui/WelcomeStep.tsx:16`

**Evidence.** The page is `name="Scheduled tasks"`; the filter beside it is `placeholder="Filter schedules..."` with the empty state `"No schedules match your filters"`; the form's collapsible section is `Schedule` while the thing being created is a Task; the history panel's rows are "runs" under a `Trigger` column; onboarding promises `"Schedule tasks"`. Three nouns, one concept, one screen — and "Trigger" is unglossed jargon for "what set this off".

**Recommendation.** Fix the noun to **task** on this surface (the page title and onboarding already use it): `"Filter schedules…"` → `"Filter tasks…"`; `"No schedules match your filters"` → `"No tasks match your filters"`. The `Schedule (optional)` section keeps its name — it genuinely names the _timing_, not the task. `Trigger` → `Started by`.

### 8.5 — The topology page says "namespace" while its own headings say "project"

**P2 · M · lens 7**
`apps/client/src/layers/features/mesh/ui/TopologyPanel.tsx:175,196,269-273,287,299-305`, `layers/features/mesh/ui/TopologyLegend.tsx:81,87,99`

**Evidence.** In one panel: the heading `"Namespaces"` sits directly above the heading `"Cross-Project Access Rules"`; the empty state reads `"Cross-project access requires multiple namespaces"` with the description `"Register agents from different directories to create namespaces, then configure cross-namespace access rules."`; the body reads `"No cross-project rules. Agents can only communicate within their own namespace."`; the select placeholders say `"Select namespace"`. So one concept is "namespace", "project" and "directory" within four lines, and the one word a user would understand is the one used only in headings. The legend entry `"Relay-enabled"` names an internal subsystem the user never chose.

**Recommendation.** Standardise on **project**, since two of the three headings already do. `"Namespaces"` → `"Projects"`; `"Select namespace"` → `"Pick a project"`; the empty-state headline → `"You need agents in more than one project"`; its description → `"Add agents from a second folder. Then you can let the two projects talk."`; the body → `"No rules yet. Right now agents only talk to others in the same project."`; `"Relay-enabled"` → `"Can message other agents"`. Code identifiers (`namespace`, `sourceNamespace`) stay untouched.

### 8.6 — "Runtime" and "Max Runtime" sit in one form meaning two unrelated things

**P2 · S · lens 7**
`apps/client/src/layers/features/tasks/ui/TaskExecutionFields.tsx:75`, `layers/features/tasks/ui/TaskFormInner.tsx:373,536,554`

**Evidence.** The create-a-task form renders, in order: `<Label>Runtime</Label>` meaning _which agent engine_; `<Label>Cron Expression</Label>` with a crontab.guru link as its only explanation; `<Label>Max Runtime</Label>` with `placeholder="10m"` and **no description**, meaning _how long the run may last_; and `<Label>Sticky</Label>`, which has a good description. The same word carries two meanings eight rows apart, and neither is glossed.

**Recommendation.** `Runtime` → `Agent engine` (or the ADR-safe `Runs on`); `Max Runtime` → `Stop after`, with `"Give up if the run takes longer than this."`; `Cron Expression` → `Custom timing` with `"Advanced. Write a cron line, or use the presets above."`; `Sticky` → `Remember the last run`, keeping its existing description verbatim.

### 8.7 — "Runtime(s)" is never explained to the person who has to configure it

**P2 · S · lens 7**
`apps/client/src/layers/features/settings/ui/SettingsDialog.tsx:62-63`, `layers/features/settings/ui/runtimes/RuntimesTab.tsx:127-128`, `rows/ModelRow.tsx:92`, `rows/EffortRow.tsx:120`, `GlobalTrustRow.tsx:125`, `RuntimeCardView.tsx:47`

**Evidence.** Onboarding deliberately avoids the word — it names Claude Code, Codex and OpenCode directly and only falls back to `'A runtime is connected.'` in a degenerate branch. The moment the user reaches Settings the word is everywhere and never defined: tab `label: 'Runtimes'`, `aria-label="Check runtimes again"`, `"Leave it on Runtime's choice to let Claude Code decide."`, `"Every runtime follows this unless its card says otherwise."`, `"Your default runtime isn't connected."` A runtime is an architecture concept (ADR-0255/0310); the user's concept is "the AI tool that does the work".

**Recommendation.** Cheapest honest fix, no rename: one glossing sentence at the top of the Runtimes tab — `"Runtimes are the AI tools DorkOS runs for you: Claude Code, Codex and OpenCode."` — and drop the word from the rows that can lose it (`"Leave it on Runtime's choice…"` → `"Leave it on Automatic to let Claude Code pick."`). If a rename is later on the table, "AI tools" is the phrase; the gloss buys most of the value for an hour.

---

## Batch 9 — Copy: register, casing and the error voice

**Priority P2 · 9 findings · 4S · 5M**
**Scope:** how the app sounds. The reference register already exists in the codebase — `features/notifications/**` and `settings/ui/tabs/NotificationsTab.tsx` are the best copy in the app; these findings point everything else at it.

### 9.1 — Settings speaks in two registers, and the older one is a man page

**P2 · M · lens 7**
`apps/client/src/layers/features/settings/ui/AdvancedTab.tsx:59-68,110-117,132-134,152-154,177-197,247`, `ToolsTab.tsx:153-154`, `tabs/AppearanceTab.tsx:48,61,79`, `external-mcp/RateLimitSection.tsx:24-25`, `tools/SchedulerSettings.tsx:26,40`, `PrivacyTab.tsx:63`; contrast `tabs/NotificationsTab.tsx:44-84`

**Evidence.** One dialog, two voices. Notifications is exemplary — `label="Knock when an agent needs you"`, `description="A soft double-knock the moment something stops and waits for your answer."` — benefit first, one idea per sentence, no jargon. Three tabs away:

| Current                                                                             | Problem                                             |
| ----------------------------------------------------------------------------------- | --------------------------------------------------- |
| `"Poll for updates to sessions running outside DorkOS (e.g. the Claude Code CLI)…"` | "Poll", "e.g.", mechanism-first, 24 words           |
| `"Server log verbosity"`                                                            | two nouns, no verb, no actor                        |
| `"Size in KB before a log file is rotated"`                                         | passive, "rotated" undefined                        |
| `"Number of old log files to retain (1-30)"`                                        | passive, "retain"                                   |
| `"Restart the DorkOS server process. Active sessions will be interrupted."`         | "server process", passive second sentence           |
| `"Server info, agent identity, app controls, and preview reads"`                    | a noun list with no verb; "preview reads" is opaque |
| `"Limit external MCP requests per time window"`                                     | MCP unglossed, "time window"                        |
| `"Scheduled runs at once"` / `"Completed runs to keep"`                             | fragments                                           |
| `"Choose your preferred color scheme"`                                              | says only what the control obviously does           |
| `"Payload shown below."`                                                            | "payload", on the privacy tab of all places         |

Priya will forgive it; Ikechi cannot use it.

**Recommendation.** Rewrite to the Notifications register. Suggested: `"Watch for agents you started somewhere else"` / `"Turn this on if work you started in a terminal takes a while to show up here."`; `"How much detail DorkOS writes down"`; `"How big one log file gets before DorkOS starts a new one"`; `"How many old log files to keep"`; `"Restart DorkOS. Anything running right now stops."`; `"Let agents check the app, know who they are, and read what you're previewing."`; `"Cap how many requests other apps can send DorkOS in a minute."`; drop `"Choose your preferred color scheme"` entirely (the control shows the choices); `"You can see exactly what gets sent below."`

### 9.2 — The "Failed to…" family, and raw server errors handed to the user verbatim

**P2 · M · lens 7**
`apps/client/src/layers/shared/lib/query-client.ts:108,136`, `layers/shared/ui/app-crash-fallback.tsx:55`, plus ~25 sites including `settings/ui/RestartDialog.tsx:33`, `ResetDialog.tsx:38`, `external-mcp/ExternalMcpCard.tsx:297,309`, `extensions/ui/ExtensionsSettingsTab.tsx:47,62,70,73`, `SettingFieldRenderers.tsx:69,127,189,238`, `ask/ui/QuestionPrompt.tsx:155`, `mesh/ui/TopologyGraph.tsx:278`, `status/ui/ModelSelectionList.tsx:67`

**Evidence.** Two problems, one pattern. First, `Failed to X` is the app's default error voice: `'Failed to restart server'`, `'Failed to reset data'`, `'Failed to fork session'`, `'Failed to load topology'`, `'Failed to load models'`, and the global default `'Failed to load data'` at `query-client.ts:108`. None of them says what to do next, and "failed to" has no actor. The app already knows the better register — `"Couldn't branch off this conversation."` (`SessionSwitcher.tsx:191`), `"Couldn't send. Try the GitHub option."`, `"Couldn't save your version"`.

Second, raw errors lead. The dominant idiom is `toast.error(err instanceof Error ? err.message : 'Failed to X')`, so the _fallback_ is the only authored copy and the common path shows whatever the server or Node threw. `query-client.ts:136` makes it app-wide: ``const line = label ? `${label} — ${error.message}` : 'Action failed. Please try again.'``. `app-crash-fallback.tsx:55` renders the bare `error.message` as the only explanation on the crash screen. A user meets `ENOENT: no such file or directory, open …` with no gloss.

**Recommendation.** Three mechanical moves. (1) Rename the family: `Failed to X` → `Couldn't X`, adding a next step where one exists (`"Couldn't reach the server. Check DorkOS is still running."`). (2) Change the global defaults: `'Failed to load data'` → `"Couldn't load that. Try again."`; `'Action failed. Please try again.'` → `"That didn't work. Try again."` (3) Stop leading with `err.message` — invert the idiom so the authored sentence is the headline and the raw text is the Sonner `description`, which `SessionSwitcher.tsx:191` already does correctly. Same for the crash fallback: a plain lead sentence with `{message}` under a "Details" line.

### 9.3 — Title Case, sentence case and SHOUTED headers, all in one product

**P2 · M · lens 7**
`apps/client/src/layers/widgets/home/ui/PinnedTriageHeaderView.tsx:88,494,524,543`, `router.tsx:280,281`, `layers/features/command-palette/ui/AgentSubMenu.tsx:89,105,110`, `settings/ui/AdvancedTab.tsx:59,75,110,177,183,195`, `settings/ui/ServerTab.tsx:78,79`, `settings/ui/RemoteAccessAction.tsx:22`, `layers/shared/ui/sidebar.tsx:270,283,286`, plus ~20 more

**Evidence.** There is no house casing rule and it shows. `router.tsx:280` `title="Marketplace Sources"` sits one line above `:281` `title="Product feedback"`. `AgentSubMenu` renders `Open Here`, `New Session` and `Browse sessions…` as three consecutive items in one menu. The home surface is the worst offender because it is the first screen: `TriageGroup` headings are `"Waiting On You"`, `"Needs Attention"`, `"Recent Activity"` — Title Case with a wrongly capitalised preposition — rendered `text-xs font-medium tracking-widest uppercase`, while `design-system.md` §"Zones and Sections" says the opposite in as many words: section labels are "sentence case, 11px medium… ALL-CAPS with letterspacing reads dated at small sizes."

**Recommendation.** Adopt **sentence case everywhere except proper nouns** (product names, "Claude Code", "DorkOS", "Slack") and write it into `contributing/design-system.md` beside the section-header rule that already implies it. Then sweep: `Waiting On You` → `Waiting on you`; `Needs Attention` → `Needs attention`; `Recent Activity` → `Recent activity` (and drop the uppercase/letterspacing treatment); `Background Updates` → `Background updates`; `Danger Zone` → `Danger zone`; `Reset All Data` → `Reset all data`; `Restart Server` → `Restart DorkOS`; `Core Tools` → `Core tools`; `Working Directory`/`Data Directory` → `Working folder`/`Data folder`; `Open Here` → `Open here`; `Add Marketplace Source` → `Add a marketplace source`; `Toggle Sidebar` → `Toggle sidebar`; `Dismiss Group` → `Dismiss these`.

### 9.4 — Message-queue jargon on the dashboard a new user lands on

**P2 · M · lens 7**
`apps/client/src/layers/features/dashboard-attention/ui/DeadLetterDetailSheet.tsx:46,55-56,62,79,95`, `layers/features/relay/ui/DeadLetterSection.tsx:106,132`, `dashboard-attention/ui/FailedRunDetailSheet.tsx:67`, `OfflineAgentDetailSheet.tsx:82`

**Evidence.** The attention sheets that open from Home say, verbatim: `Dead Letters` (sheet title), `{count} undeliverable message(s)`, `First seen:` / `Last seen:`, `Sample payload` above a raw `JSON.stringify(...)` block, `Dismiss Group`, `Mark dead letters as resolved?`, and `Sample Envelope`. The description line is the raw `source` string, falling back to `'Unknown source'`. "Dead letter", "envelope", "payload" and "source" are message-broker vocabulary; nothing on the sheet glosses any of them, so a person who has never run a message queue cannot tell whether this is bad, whose fault it is, or what "dismiss" does.

**Recommendation.** Retitle in user terms: `Dead Letters` → `Messages that never arrived`; `{n} undeliverable messages` → `{n} messages couldn't be delivered`; `First seen`/`Last seen` → `First happened`/`Last happened`; `Sample payload` → `What one of them looked like` (collapsed by default); `Sample Envelope` → `What was sent`; `Dismiss Group` → `Clear these`; `Mark dead letters as resolved?` → `Clear these messages?`; `'Unknown source'` → `"We don't know where these came from"`. Add one framing sentence at the top: `"These messages were meant for an agent and never got there. Clearing them doesn't send them."` Same pass for `Failed Run` → `Run that didn't finish` and `Offline Agents` → `Agents that aren't answering`.

### 9.5 — Em dashes in ~109 user-facing strings, including the app-wide error toast

**P2 · M · lens 7**
`apps/client/src/layers/shared/lib/query-client.ts:136` (the format string every failed mutation uses), `settings/ui/ToolsTab.tsx:147`, `agent-settings/ui/ToolsTab.tsx:245,335,436`, `status/ui/AutoModeConfirmDialog.tsx:52`, `feature-promos/ui/dialogs/SchedulesDialog.tsx:33`, `shared/ui/trust-dial.tsx:108`, `settings/ui/runtimes/GlobalTrustRow.tsx:164`, `settings/ui/WelcomeBackCard.tsx:75`, `tabs/NotificationsTab.tsx:61,131`, `connections/ui/SessionConnectorsGroup.tsx:21,22`, plus ~95 more (6 spelled `&mdash;`)

**Evidence.** The writing-for-humans house rule is unambiguous: "**no em dashes.** They invite run-on sentences that smuggle in a second idea." The highest-traffic offender is structural rather than authored — `` `${label} — ${error.message}` `` means every mutation failure in the app renders one by construction. The rule's own prediction holds in practice: `ToolsTab.tsx:147` is a 44-word sentence held together by one. (Note: a raw grep for `—` across `layers/*.tsx` hits 1,235 files, but the overwhelming majority are code comments, which the rule does not bind; the ~109 figure is the copy-position subset the copy lens filtered to, and the sweep should re-derive it rather than trust the raw count.)

**Recommendation.** Fix the structural one first: `` `${label}. ${error.message}` `` — a period, so the halves read as two sentences. Then sweep the authored strings, splitting where the dash joins two ideas and using a colon or comma where it does not. Consider adding em dash as a `check-vocab-gate.ts` rule scoped to copy positions; it is the same mechanism and the only thing that will keep the sweep paid.

### 9.6 — A non-developer is handed a shell command with nowhere to type it

**P2 · S · lens 7**
`apps/client/src/layers/shared/ui/FeatureDisabledState.tsx:11-27`, `layers/widgets/tasks/ui/TasksPage.tsx:73-79`, `layers/widgets/connections/ui/MessagingRegion.tsx:57-63`

**Evidence.** The shared primitive renders `{name} is currently disabled`, a description, and a bare `InlineCode` block. Its two production users: `"Scheduled tasks run your agents on a timer. Start DorkOS with the --tasks flag to turn them on."` with `dorkos --tasks`; and `"Messaging is off, so nothing outside DorkOS can reach your agents yet. Start DorkOS with it on."` with `DORKOS_RELAY_ENABLED=true dorkos`. Nothing says _where_ to type it, and the second shows an environment-variable prefix with no explanation. Ikechi is stuck here. The primitive is also inconsistent with itself — passive voice plus the filler "currently".

**Recommendation.** Change the headline to `"{name} is off"` and add an optional `commandHint` line above the code block, defaulting to `"Quit DorkOS, then start it again in your terminal with:"`. Lead the descriptions with the benefit: `"Scheduled tasks let your agents work on a timer, even when you're not here."` / `"Turn on Messaging so people can reach your agents from Telegram, Slack and elsewhere."` Add a `CopyButton` to the code block; it already exists in `shared/ui`.

### 9.7 — The first-run error message shows the user internal config keys

**P2 · S · lens 7**
`apps/client/src/layers/features/onboarding/model/use-onboarding.ts:109`

**Evidence.** ``toast.error(`Failed to save onboarding progress (${keys})`)`` where `keys` is a join of internal onboarding state field names. This fires during the first minutes of the product, on the surface where the user has the least context and the most doubt: passive "Failed to", no actor, an unexplained parenthetical of internal identifiers, no next step.

**Recommendation.** `"DorkOS couldn't save where you got to in setup. You can keep going, and it will try again."` Keep `keys` for the console and breadcrumb trail, not the toast.

### 9.8 — The Channels empty state points at a sidebar that does not exist on phone

**P2 · S · lenses 7 + 8**
`apps/client/src/layers/widgets/room-view/ui/ChannelsPage.tsx:49-59`; mobile nav model at `layers/widgets/mobile-tabs/ui/MobileTabsLayout.tsx:1-43`

**Evidence.** At 390×844 the copy reads _"Channels and direct messages live in the sidebar. Open one to read it, or make a new channel…"_ There is no sidebar on screen, no hamburger, and the shadcn `Sidebar`/`SidebarTrigger` primitives have zero call sites outside their own file. The real mobile navigation is a well-built "Library" panel raised from the bottom "All" tab — `MobileTabsLayout`'s own header comment says _"Mobile is a different app, not a squeezed desktop… no hamburger, no scrim."_ The redesign is good; the empty-state copy simply never got updated, so a first-time mobile user reads instructions describing a UI element that was deliberately removed. On desktop the same copy has a second problem: it names an action ("make a new channel") without placing a control for it anywhere nearby — the only path is the small `+` in the sidebar's Channels header, off-screen from this text.

**Recommendation.** Make the copy breakpoint-aware — `"Pick a conversation from All below"` on phone, keeping the sidebar phrasing where a sidebar is visible (`useIsMobile()` is already imported throughout for exactly this). On desktop, either add a small "New channel" button to the empty state itself or reword to point at the affordance explicitly (`"Use + next to Channels to start one"`).

### 9.9 — The Team toolbar's "Group: manager" is org-chart jargon the page never uses elsewhere

**P3 · S · lens 7**
`apps/client/src/layers/features/team-roster/ui/TeamRosterToolbar.tsx:108-115`

**Evidence.** Verified in source: the grouping chip renders the literal string `Group: manager`. Nothing on `/team` explains what "manager" groups by — it clusters agents under the person who owns them — and the surrounding code consistently says **owner** (`TeamRosterGrid.tsx`'s doc comments, the `activeFilters.owner` filter one control away). A newcomer has no way to guess the meaning.

**Recommendation.** Rename the label to match the surface's own vocabulary: `Group: owner`, or `Group by owner`. The `filters.group === 'manager'` value can stay in code; only the rendered string changes. Note `layers/widgets/team/__tests__/TeamPage.test.tsx:287,311` selects the chip by this text and must move with it.

---

## Batch 10 — Copy: typography and stragglers

**Priority P3 · 7 findings · 5S · 2M**
**Scope:** one mechanical sweep PR. Low risk, high polish-per-line; best done after batches 8 and 9 so the sweeps do not collide.

### 10.1 — Two ellipsis characters, 40 vs 161

**P3 · M · lens 7**
Representative: `layers/shared/ui/ConnectionStatusBanner.tsx:49`, `settings/ui/ServerRestartOverlay.tsx:88,89`, `RestartDialog.tsx:51`, `ResetDialog.tsx:89`, `composer/ui/ComposerInput.tsx:277`, `command-palette/ui/CommandPaletteDialog.tsx:587`, `ask/ui/QuestionPrompt.tsx:294,469,516`, `tasks/ui/TasksList.tsx:99`, `agents-list/ui/AgentsList.tsx:250`, `chat/ui/message/ThinkingBlock.tsx:51`

**Evidence.** 161 copy strings use `…`; 40 use three periods. They render at visibly different widths and the split is not by surface — `ConnectionStatusBanner.tsx:49` mixes both registers inside one component.

**Recommendation.** Standardise on `…` (the majority, and typographically correct) and sweep the 40. A one-line `check-vocab-gate` rule keeps it fixed.

### 10.2 — Two apostrophes, 53 straight vs 40 curly

**P3 · M · lens 7**
Straight `&apos;`: `settings/ui/AdvancedTab.tsx:228`, `ServerTab.tsx:222`, `tabs/RoomsTab.tsx:114`, `TunnelSetup.tsx:34,81`, `session-list/ui/SessionListWarningNotice.tsx:54`, `auth/ui/ApiKeysSection.tsx:144`. Curly: `tabs/NotificationsTab.tsx:131`, `ExperimentsTab.tsx:82`, `runtimes/RuntimeCardView.tsx:43,47`, `tasks/ui/TaskAgentField.tsx:107,125`, `chat/ui/ChatEmptyState.tsx:45`, `settings/ui/ToolsTab.tsx:146,210`

**Evidence.** Two Settings tabs disagree with each other: `AdvancedTab.tsx:228` and `ServerTab.tsx:222` render the identical string `Couldn&apos;t copy` straight, while `ChatEmptyState.tsx:45` renders `couldn&rsquo;t say hello` curly.

**Recommendation.** Pick curly `’` — it is what the newest, best copy uses and what reads as typeset — and sweep. Prefer the literal character over the HTML entity so a future grep for a phrase finds it.

### 10.3 — Paired empty-state lines disagree about ending in a period

**P3 · S · lens 7**
`apps/client/src/layers/features/chat/ui/ChatEmptyState.tsx:44-48,59-61`, `session-list/ui/SessionsView.tsx:86`, `dashboard-sidebar/ui/SessionSwitcher.tsx:299`, `marketplace/ui/InstalledPackagesView.tsx:223-224`, `MarketplaceSourcesView.tsx:200`

**Evidence.** One component, two conventions: the greeting-failed branch renders a headline with no period and a supporting line with one; the generic branch renders both with none. Elsewhere: `"No conversations yet"` (none) vs `"No packages installed"` + `"Browse the marketplace to discover and install your first package."` (period on the sub-line only) vs `"No sources configured"` (none).

**Recommendation.** Write the rule down: **headline no period, supporting sentence gets a period.** That matches the majority. Fix `ChatEmptyState.tsx:61` → `"Type a message below to begin."` and sweep the handful of others.

### 10.4 — Three crash and error fallbacks each invent their own recovery wording

**P3 · S · lens 7**
`apps/client/src/layers/shared/ui/app-crash-fallback.tsx:45,103,121`, `route-error-fallback.tsx:46,52,84,90,93`, `not-found-fallback.tsx:11,13,17`

**Evidence.** Three siblings, three vocabularies:

|             | Headline                                  | Recovery button                         |
| ----------- | ----------------------------------------- | --------------------------------------- |
| App crash   | `DorkOS encountered an unexpected error.` | `Reload DorkOS` + `Report this crash`   |
| Route error | `Something went wrong`                    | `Reload app` / `Retry` + `Back to Home` |
| 404         | `Page not found`                          | `Back to Home`                          |

"Reload DorkOS" and "Reload app" are the same action under two names; "Back to Home" is Title Case against sentence-case siblings; the crash headline is the only one ending in a period and the only one using a formal verb.

**Recommendation.** One vocabulary across the three: headlines `"DorkOS ran into a problem"` / `"Something went wrong"` / `"Page not found"` (no periods); buttons `Reload DorkOS`, `Try again`, `Back to home`, `Report this`. Also give the route-error case a next step — a headline followed by a raw `error.message` tells the user nothing they can act on.

### 10.5 — Two screen-reader announcements about the same prompt use different voices

**P3 · S · lens 7**
`apps/client/src/layers/features/ask/ui/ApprovalPrompt.tsx:263-267`

**Evidence.** One ternary chain produces three announcements for one countdown: `'Nobody answered. The agent is waiting for you.'` (plain, actor named), `'Urgent: 1 minute to approve or deny.'` (telegraphic), `'Tool approval required. 2 minutes remaining.'` (passive, and "tool approval" is a concept the visible card never uses). A screen-reader user gets the least plain sentence at the moment they have the most time to act.

**Recommendation.** Match the first line's voice throughout: `"Two minutes left to answer."` / `"One minute left to answer."` / `"Nobody answered. The agent is waiting for you."`

### 10.6 — `ElicitationPrompt` says things nobody says

**P3 · S · lens 7**
`apps/client/src/layers/features/ask/ui/ElicitationPrompt.tsx:83,161,179`

**Evidence.** The card reads `{agent} requests input`, its confirm button says `I authorized it`, and its failure path sets `'Failed to submit'`. The neighbouring `ApprovalCard` already speaks plainly (`'Changes things'`, `'Cannot be undone'`). "I authorized it" is also past tense for an action the user is about to take.

**Recommendation.** `{agent} needs something from you`; button `Done`; error `"Couldn't send your answer. Try again."`

### 10.7 — Small stragglers worth folding into whichever sweep touches them

**P3 · S · lens 7**
`apps/client/src/layers/features/marketplace/ui/MarketplaceSourcesView.tsx:105,200`, `settings/ui/external-mcp/ExternalMcpCard.tsx:116,252`, `marketplace/ui/PackageDetailSheet.tsx:477`, `extensions/ui/ExtensionsSettingsTab.tsx:70`, `agent-settings/ui/ConventionFileEditor.tsx:81`, `settings/ui/RemoteAccessAction.tsx:22`

**Evidence and fixes.**

- `<Label>Git URL</Label>` → `Repository link` (with a placeholder showing one).
- `"No sources configured"` → `"No marketplaces added yet"` ("configured" is dev register).
- `No auth` / `No token` chips → `Not protected` / `No key yet`.
- `"Permissions & Effects"` → `"What this can do"` — the section below it already says `"What this package will do"` (`PermissionPreviewSection.tsx:250`), so the heading duplicates it in worse words.
- `` `Reloaded ${updated.length} extension(s)` `` → proper pluralisation; the codebase already does this correctly at `DeadLetterDetailSheet.tsx:55`.
- `placeholder={enabled ? 'Write markdown content...' : 'Toggle on to enable injection'}` → `"Turn this on to use it"` — "injection" is internals.
- `<span>Remote Access</span>` → `Remote access`.

---

## Batch 11 — No wall of text

**Priority P2 · 4 findings · 3S · 1M**
**Scope:** the operator's 2026-09-03 directive — no surface shows a large block of static prose by default; the gist goes on screen and detail goes behind an affordance chosen to fit the context.

### 11.1 — Message search shows four sentences of prose before any query

**P2 · S · lens 7**
`apps/client/src/layers/features/command-palette/model/message-search-scope.ts:41-58` (rendered in the message-search dialog); the one-line alternative already exists at `:68-69`

**Evidence.** ⌘⇧F, before typing anything: a "What search covers" heading followed by four bulleted sentences, two of them two lines long — coverage of rooms, coverage of the three runtimes (with a "can take up to five minutes" caveat), what is never searched (tool output, with four named exclusions), and the whole-word matching rule with a worked example. The content is legitimate and satisfies a documented product commitment (spec `message-search` §1.3 G4: a user must be able to learn search's limits without reading a spec), and it is pinned by a copy-length test — but four multi-clause sentences, always visible, before the user has started typing is precisely the pattern the rule targets.

**Recommendation.** Cut the default view to one line — `SEARCH_SCOPE_SUMMARY` at `:68-69` already _is_ that line — and move the four-bullet detail behind a small info affordance, or reveal it once the user has typed and got zero results, which is the moment the whole-word caveat actually matters. This keeps G4's promise without keeping the prose on screen. Update the copy-length test with the change.

### 11.2 — Settings → Notifications is six stacked blocks of explanatory prose

**P2 · M · lens 7**
`apps/client/src/layers/features/settings/ui/tabs/NotificationsTab.tsx`

**Evidence.** A three-sentence intro sits above the controls: _"Agents work while you do something else, so DorkOS has to be able to reach you — and to stay quiet the rest of the time. A knock means something has stopped and is waiting on you. Everything else is news."_ Then every toggle repeats the pattern — bold title plus a full sentence, some two: "Chime every time a turn finishes" carries _"Plays whenever an agent finishes replying, in any session. Off to start with — with a few agents running it is a lot of sound."_ Six such blocks are visible without scrolling. Individually this is the best copy in the app (batch 9 points everything else at it); stacked six deep it is the wall-of-text pattern. A settings panel should be scannable by its bold labels alone.

**Recommendation.** Keep the bold labels as the primary scan layer. Drop the per-toggle sentence to a tooltip or info icon rather than permanent secondary text, or cut each to under ten words and move the "which mode fires when" reasoning into a single collapsible "How this works" block at the top instead of six variations of it.

### 11.3 — The Workspaces page explains what a worktree is twice, back to back

**P2 · S · lenses 3 + 7**
`apps/client/src/layers/widgets/workspaces/ui/WorkspacesPage.tsx:161-164` and `:197-205`

**Evidence.** Verified in source. Page intro: _"Every separate copy of your code found in your workspaces folder. Agents work in these so they never edit the same files at once. This page only reads them."_ Immediately below, the empty-state card: _"A worktree is a second copy of your project, on its own branch, so one agent's edits can't collide with another's. They show up here once they exist in ~/…"_ Both say the same thing in two phrasings, stacked on one screen with no query between them. The raw path in the second is also rendered as plain wrapped prose rather than a code/path element (see 1.1).

**Recommendation.** Keep one explanation. Either drop the page intro — the empty state already carries the concept — or shrink it to a five-word gist ("Copies of your code, per agent.") and let the empty state carry the detail once. Style the path as code, not prose.

### 11.4 — The install dialog decides seven times, independently, how much to open

**P3 · S · lens 11**
`apps/client/src/layers/features/marketplace/ui/PermissionPreviewSection.tsx:170-262`, `InstallConfirmationDialog.tsx:202-275`

**Evidence.** `PermissionPreviewSection` renders seven `<details>` sections, each deciding its own initial state with `const open = defaultOpen ?? items.length <= 3`, and two (Commands, Jobs) forced open. A package with three rows in each of five optional sections opens all of them: roughly 20 rows across seven uppercase headings, above a scope radio group and an agent picker. The per-section heuristic is locally sensible and globally unbounded — there is no dialog-level budget, which is exactly the gap the composer status line closed with `applyStatusBudget`. For Ikechi this is the first security decision the product asks him to make, and a wall of open sections reads as "this is complicated". The constraint is real though: DorkOS is honest by design, so the fix must not _hide_ risk.

**Recommendation.** Keep **Commands** and **Conflicts** always expanded — the component's own doc comment identifies those two as "what a person needs to see before trusting a stranger's package". Collapse Effects, Secrets, Hosts and Dependencies by default, each with its count in the summary so nothing is concealed, and add a one-line verdict above the sections derived from the same data ("Adds 4 skills for all agents. Declares no commands."). Nothing is removed; the reader is given an order to read it in.

---

## Batch 12 — Settings information architecture

**Priority P2 · 6 findings · 5S · 1M**
**Scope:** one PR reshaping the Settings dialog. Thirteen tabs today; these findings take it to eleven with predictable contents. Deep links must keep working via the legacy map in `use-dialog-deep-link.ts`, which exists for exactly this kind of move.

### 12.1 — "Advanced" is a junk drawer, and three of its four sections belong on other tabs

**P2 · M · lens 11**
`apps/client/src/layers/features/settings/ui/AdvancedTab.tsx:57-217`, `SettingsDialog.tsx:112`

**Evidence.** One tab holds four unrelated sections in a flat stack: **Background Updates** (a polling switch, `:59-73`), **Message Box** (the rich-text switch, `:75-106`), **Logging** (level, max file size in KB, rotated files kept, log location, `:108-173`), and **Danger Zone** (Reset All Data, Restart Server, `:175-205`). Every row is at the same visual level; nothing is collapsed. "Advanced" is not a category, it is the absence of one — and three of the four have an obvious home. "Format text as you type" is a composer preference whose own inline comment says it is now ON by default, so it is not advanced at all. "Background refresh" is a general app preference. Logging is a property of this machine's server, which is what the Server tab is. What is left — Reset and Restart — is a real danger zone and deserves to be the tab. Meanwhile `maxLogSizeKb` and `maxLogFiles` are two numeric fields that matter to almost nobody, rendered flat _above_ the destructive actions.

**Recommendation.** Redistribute: Message Box → Preferences (beside the other chat-display rows); Background refresh → Preferences; Logging → Server, inside a `CollapsibleFieldCard` labelled "Logging" (level visible in the summary, rotation fields inside). Rename the tab **Danger zone** and let it hold only Reset and Restart, so its icon and name predict its contents.

### 12.2 — "Background refresh" is a machine-wide preference offered as a per-session control

**P2 · S · lens 11**
`apps/client/src/layers/features/status/model/status-bar-registry.ts:470-486`, `layers/features/status/ui/SessionPopover.tsx:252-260`, `layers/features/chat/ui/status/ChatStatusSection.tsx:104-105`, `settings/ui/AdvancedTab.tsx:66-71`

**Evidence.** The `polling` registry entry sits in the **`controls`** group of the Session popover and renders a `Switch`. Its value comes from `useAppStore((s) => s.enableMessagePolling)` — a global app-store field, not session state — and the identical switch also exists in Settings → Advanced. This is the defect the registry itself records having fixed for a sibling row seven lines above: _"`sound` used to live here as a switch. It is gone (DOR-1385): it read as a per-session control and was not one — it flipped a preference for every session on the machine."_ `polling` has exactly that property and was left in place. A person toggling it inside the Session panel reasonably believes they changed this session; they changed every window on the machine.

**Recommendation.** Remove the `polling` entry from the registry's `controls` group the way `sound` was removed, leaving Settings as its one home. If a shortcut from the session is still wanted, make it a link into `?settings=…` — a deep link cannot misrepresent its scope. The `controls` group then holds only `plan`, which genuinely is per-session.

### 12.3 — The first four tabs are an unnamed implicit group, and "Remote Access" is a dialog wearing a tab's clothes

**P2 · S · lens 11**
`apps/client/src/layers/features/settings/ui/SettingsDialog.tsx:35-52,112,135,140`, `RemoteAccessAction.tsx:11-38`, `apps/client/src/layers/shared/ui/tabbed-dialog.tsx:126-131,191-212`

**Evidence.** Thirteen tabs. Nine carry a `group` — "Agents & sessions", "Access & privacy", "System" — and four (Profile, Appearance, Preferences, Notifications) carry none, so `tabbed-dialog.tsx:126-131` renders them as a headerless run above the first section header: the list reads as "four loose things, then three real sections". Below the last group, `sidebarExtras` renders `RemoteAccessAction` — a button styled almost exactly like a `NavigationLayoutItem` (icon + label + hover tint) that opens `TunnelDialog`, a second modal on top of the settings modal. On mobile it even renders with the drill-in `ChevronRight` every _tab_ row uses, so the disguise is strongest exactly where the recovery gesture is worst. A control that sits in a list of tabs and looks like a tab must swap the panel; that is the one promise a settings sidebar makes.

**Recommendation.** Name the first group ("You" or "Personal") so all four regions are labelled peers. Move Remote Access into **Access & privacy** as a real tab whose panel is the current `TunnelSettings` content — same subject as Security and DorkOS account, and it removes a dialog-over-dialog. `sidebarExtras` then has no production consumer and can go.

### 12.4 — "Preferences" is a leftover bucket

**P2 · S · lens 11**
`apps/client/src/layers/features/settings/ui/tabs/PreferencesTab.tsx:76-153`

**Evidence.** One card holding six switches — Show timestamps, Expand tool calls, Auto-hide tool calls, To-do celebrations, Feature suggestions, **Show dev tools** — then `WelcomeBackCard`, then a second card with **Replay setup**. Four of the six are chat-display settings; one is a promotion control; one turns on a developer panel; the tail is a first-run flow you can re-trigger. "Preferences" here means "settings that had nowhere else to go", the same failure as Advanced one tab down. A developer-tools toggle sitting flat between "To-do celebrations" and a re-run of onboarding is what makes Ikechi feel he is in the wrong room, and Kai has to read six unrelated labels to find the one about tool cards. The tab's own comments (`:107-117`) already record two settings being moved out for coherence, so the direction of travel is established.

**Recommendation.** Group inside the tab rather than adding tabs: one **Chat** `FieldCard` (timestamps, expand tool calls, auto-hide tool calls, celebrations, plus the Message Box row relocated from Advanced per 12.1), and one **Discovery** row (Feature suggestions beside "Replay setup" — both are about being shown things again). Move "Show dev tools" to the System group with the other developer-facing switches.

### 12.5 — Server settings mixes the one thing you came for with five diagnostics

**P3 · S · lens 11**
`apps/client/src/layers/features/settings/ui/ServerTab.tsx:41-83,141-174`

**Evidence.** Eight flat rows at the same weight: Version, an update notice, Address + MCP endpoint, Uptime, Working Directory, Data Directory, Boundary, Node.js — every one a click-to-copy row. Two of these are why anyone opens the tab (the address to paste into an MCP client, and the version); the rest are diagnostics you want once, when something is wrong. "Boundary" and "Node.js" are words Ikechi has no model for, and presenting them at the same weight as the address costs the address its prominence. The tab already has a `CopyDiagnosticsButton` sibling in `features/status` proving the "copy the whole lot" pattern exists here.

**Recommendation.** Keep Version, Address, MCP endpoint and Uptime at the top level. Put Working Directory, Data Directory, Boundary and Node.js inside a `CollapsibleFieldCard` labelled "Diagnostics", collapsed by default, with one copy-all control in its header — so the support path is one click and one paste rather than four separate copies.

### 12.6 — "Security" and "DorkOS account" are two tabs holding one question

**P3 · S · lens 11**
`apps/client/src/layers/features/settings/ui/SecurityTab.tsx:1-12`, `CloudAccountTab.tsx`, `SettingsDialog.tsx:78-98`

**Evidence.** The "Access & privacy" group holds three tabs, two of which are 12-line and 14-line wrappers: `SecurityTab` renders `SecurityPanel` (local login + API keys) and `CloudAccountTab` renders the cloud link. Both answer "who can get into this install, and as whom". Two sidebar rows, two icons and two panel headers for one panel's worth of content, in a sidebar already carrying thirteen rows. Every element justifies its existence (AGENTS.md §Quality Standard) — a tab whose whole body is one component and whose subject is the neighbouring tab's subject does not.

**Recommendation.** Merge into one **Access** tab with two `FieldCard` sections ("On this machine" — login and API keys; "DorkOS account" — the cloud link). Keep `?settings=security` and `?settings=account` working through the legacy map in `use-dialog-deep-link.ts` and let it scroll to the section.

---

## Batch 13 — The session surface: fewer things competing

**Priority P2 · 5 findings · 1S · 4M**
**Scope:** the `/session` route and the right panel. Every finding here is "an internal standard exists and has not reached a second surface" — the arbiter, the viewport cap, the disclosure primitive.

### 13.1 — The zone between the transcript and the composer has no arbiter

**P2 · M · lens 11**
`apps/client/src/layers/widgets/session/ui/ChatPanel.tsx:492-580`, `apps/client/src/layers/shared/ui/bottom-slot.tsx:1-19`, `layers/features/notifications/ui/PermissionPrimer.tsx:94-102`, `layers/shared/ui/PromptSuggestionChips.tsx`

**Evidence.** `ChatPanel` renders, in flow between `SessionTranscript` and `SessionComposer`: `TerminalReasonChip`, `Conversation.LiveLane`, `PromptSuggestionChips`, the `chat.suggestion-chips` extension slot (N contributions), `TaskListPanel`, `TurnFailedNotice`, an error block, and `PermissionPrimer` — eight independent blocks, each gating itself on its own predicate, with no shared priority and no shared budget. `PromptSuggestionChips` (`:526`) and the extension chips (`:536`) both fire on `status === 'idle'`; `TaskListPanel` (`:543`) fires on `tasks.length > 0`; `PermissionPrimer` (`:572`) fires independently. They co-occur. ADR `260819-210153` decided exactly this question for the sidebar — "four independent cards with no shared priority" — and shipped `shared/ui/bottom-slot.tsx`, whose own header says "This is the one place they arbitrate: highest priority wins, and the next card waits its turn." The primitive already takes an ordered candidate list and knows nothing about the features it renders. The chat panel is the second instance of the problem the ADR solved and did not get the fix.

**Recommendation.** Wrap the promotional and advisory blocks — `PromptSuggestionChips`, the extension chip slot, `PermissionPrimer`, and any future card — in a `BottomSlot` with an explicit priority order, so at most one speaks at a time. Leave the three that are not competing for attention outside it: `LiveLane` (a reserved line by design), `TaskListPanel` (content about the running turn, not an offer), and the error/turn-failed blocks (a failure must never be arbitrated away). Document the priority beside the candidate list the way `useAppBanners` does.

### 13.2 — The session to-do panel opens expanded and uncapped, directly above the composer

**P2 · S · lens 11**
`apps/client/src/layers/features/chat/ui/tasks/TaskListPanel.tsx:27,56,63,74`, `layers/features/chat/model/use-task-state.ts:78`, `layers/widgets/session/ui/ChatPanel.tsx:543-551`

**Evidence.** `use-task-state.ts:78` initialises `useState(false)` for `isCollapsed`, so the panel arrives **open**. `TaskListPanel.tsx:27` sets `MAX_VISIBLE = 10`, and the `<motion.ul>` at `:74` is `className="mt-1 space-y-0.5"` — no `max-h`, no internal scroll. Ten task rows plus the progress header plus the active-form line render in flow between transcript and composer, on every device. The repo has already measured this exact failure once: `PinnedTriageHeaderView.tsx:26-53` documents that at 375×812 "the room's masthead, composer and presence line already spend ~180px, so a 50svh header leaves the conversation under a third of the screen", and caps that header at `max-h-[40svh] sm:max-h-[50svh]`. The to-do list is the same shape of component in the same position with none of that protection: an agent that emits a ten-item plan pushes the conversation off the phone screen, by default rather than on request.

**Recommendation.** Two small changes. (a) Give the list the same treatment the triage header got — `max-h-[30svh] sm:max-h-[40svh]` plus `overflow-y-auto` on the `<ul>` — so a long plan scrolls inside itself instead of growing the zone. (b) Default `isCollapsed` to `true` once the turn that produced the list has ended, keeping it open only while the plan is actively changing. The progress header already carries the counts, so a collapsed panel loses no signal.

### 13.3 — The right panel carries six competing tabs on `/session`, in a panel that floors at 320px

**P2 · M · lens 11**
`apps/client/src/app/init-extensions.ts:144-300`, `layers/features/right-panel/ui/RightPanelHeader.tsx:136-300`, `layers/features/right-panel/model/use-right-panel-sizing.ts:18`

**Evidence.** `registerRightPanelTabs` registers six contributions visible on `/session`: Pulse (5), Profile (10), Session (12), Files (15), Canvas (20), Terminal (25); a seventh, Room, is visible on `/` and `/channels`. The strip renders every one as icon + label at `text-[10px]` inside a horizontally scrolling box with edge fades, and the panel's floor is `MIN_WIDTH_PX = 320`. `RightPanelHeader.tsx:136-143` states the problem in its own doc comment: _"Six tabs are wider than a 375px overlay panel, and a tab pushed past the edge with no way to reach it is a lost surface."_ A scroll-plus-fade is a mitigation, not a design: at the panel's own minimum width roughly half the tabs are off-screen, so "where is the terminal" depends on scroll position, and the mitigation itself needed a `ResizeObserver` over three boxes plus an explicit reveal (`:196-235`) to stop being wrong. Two of the six also overlap by the registry's own admission — `init-extensions.ts:234-241` says the Session tab and the status line's `⋯` popover "answer the same question at two different commitments".

**Recommendation.** Get `/session` to four or fewer. The natural merge is a single **Workspace** tab holding Files, Canvas and Terminal behind an inner segmented control: they are one concept (this session's working directory), they are gated on the same route, and Terminal already self-hides under the Obsidian transport, so the inner control is already variable-length. That leaves Pulse · Profile · Session · Workspace. If a further cut is wanted, fold the Session readout into Profile as a section rather than a peer, since the `⋯` popover already covers the two-second peek.

### 13.4 — Four different progressive-disclosure idioms, so "Advanced" looks different on every surface

**P2 · M · lens 11**
`apps/client/src/layers/shared/ui/field-card.tsx:57-91` (`CollapsibleFieldCard`), `layers/features/tasks/ui/TaskFormInner.tsx:363-369,413-418` (native `<details>` with hand-rolled summary chrome), `layers/features/marketplace/ui/PermissionPreviewSection.tsx:170-199` (native `<details>`, a third summary style), `layers/features/settings/ui/runtimes/RuntimeCardView.tsx:379-386` and `settings/ui/tools/ToolGroupRow.tsx:82-110` (Radix `Collapsible`, two different trigger treatments), `layers/features/chat/ui/tools/ToolCallCard.tsx:113` (`CollapsibleCard`), `layers/features/agent-settings/ui/IdentityTab.tsx:363` (`CollapsibleFieldCard`)

**Evidence.** `design-system.md` §FieldCard documents `CollapsibleFieldCard` as _the_ disclosure primitive for settings groups; it has exactly three production call sites. Everywhere else disclosure is re-implemented: a native `<details>` with `ChevronRight … group-open:rotate-90` in the task form, a different native `<details>` with its own summary typography in the install preview, a bare Radix `Collapsible` with an inline text trigger in the runtime card, and another with an `asChild` row trigger in `ToolGroupRow`. Progressive disclosure only works if the affordance is learnable — someone who learns that a chevron-and-uppercase-label opens a section in the install dialog gets no help from that in the task form, the runtime card or agent settings. The _behaviour_ also differs invisibly: only `CollapsibleFieldCard` supports a `badge` summarising what is inside, so the other three disclose without saying what they are hiding, which is the half of disclosure that makes it safe.

**Recommendation.** Settle on `CollapsibleFieldCard` for every **form or settings** disclosure — including a trailing summary badge stating what is inside ("3 overrides", "7 files") — and migrate the four hand-rolled ones. Keep native `<details>` only for disclosure _inside content_ (a tool card's output, a stack trace in `route-error-fallback.tsx`), and write that rule into `contributing/design-system.md` so the next author has a rule rather than five examples. Overlaps lens 3; the finding here is about the affordance, not the code duplication.

### 13.5 — Pulse duplicates the Activity page it sits beside

**P2 · M · lens 11**
`apps/client/src/layers/widgets/pulse/ui/PulseActivitySection.tsx:20-62`, `PulseAttentionSection.tsx`, `PulsePanel.tsx:29-35`, `layers/widgets/activity/ActivityPage.tsx:38-64`

**Evidence.** On `/activity` with the right panel open, the main content area's "Today" table and the Pulse panel's "Activity" table show the **exact same three rows** at the same timestamps, side by side on one screen (confirmed live, screenshot `03-activity-duplicate-panel.png`). `PulseActivitySection` already reads the pathname (`useSafePathname()`, `:25`) and uses it for exactly one thing: hiding the "Open activity →" button when you are already on `/activity` (`:26`). The five teaser rows still render. A teaser exists to point at a place you are not; pointing at the page you are looking at spends a quarter of the panel to say nothing. The attention section has the same relationship to Home's pinned triage header. This is not wrong on Home, Team or Tasks, where Pulse is a global companion and the main content is something else — it is wrong on the one page whose entire purpose _is_ the activity feed.

**Recommendation.** Extend the check the code already makes: when `pathname === '/activity'`, `PulseActivitySection` returns `null`; when the route shows the team room, `PulseAttentionSection` returns `null`. If that would leave Pulse empty on those routes, that is the honest signal that the _contextual_ tab should be the default there — which is already true on Home, where the Room tab wins auto-select (`init-extensions.ts:186-196`).

---

## Batch 14 — Shared primitives: composition debt

**Priority P2 · 13 findings · 8S · 3M · 2L**
**Scope:** `shared/ui` internals. `.claude/rules/components.md` and ADR-0097 already settle the tooling; these are the places the folder does not follow its own rules. No visual change is intended by any of them. 14.1 and 14.10 are spec-sized and should split out.

### 14.1 — Variant-shaped code across `shared/ui` bypasses `cva`/`tv`

**P2 · L · lens 2**
`switch.tsx:7-32,44-65` · `PromptSuggestionChips.tsx:20-23,98-102` · `path-breadcrumb.tsx:29-31,43-48` · `copy-button.tsx:44` · `section-header.tsx:33,52-55,182-190` · `sidebar-row.tsx:125,556-563` · `ConnectionStatusBanner.tsx:35-47` · `ScanLine.tsx:32-36` · `sheet.tsx:60-70` · `filter-bar/FilterBarPrimary.tsx:46-47`, `FilterBarSort.tsx:41`, `FilterBarAddFilter.tsx:284`, `FilterBarActiveFilters.tsx:81,136` · `option-row.tsx:26-30` · `provenance-chip.tsx:84-91` · `field-card.tsx:78-80` · `navigation-layout.tsx:329-333,351-357`

**Evidence.** `.claude/rules/components.md` §Required Patterns is explicit for this directory: "follow the existing files — `cva` variants, `data-slot` attribute on the root, `cn()` for class merging, export both the component and its `componentVariants`." Eight files do this. At least seventeen other multi-variant components express the same shape three other ways: hand-maintained `Record<Size, string>` lookup tables (`switch.tsx`'s `TRACK_SIZES`/`THUMB_SIZES`, verified; `SECTION_HEADER_HEIGHT`; `SIDEBAR_ROW_HEIGHT`); inline ternaries on a prop (`path-breadcrumb.tsx` has three `size === 'sm' ? … : …` in a row; `sheet.tsx` has four `side === 'x' &&` branches, verified); and whole class strings duplicated per branch (the four filter-bar triggers repeat `inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs` verbatim in four files).

Three observable consequences. (1) The variant system is implicit: nothing types `size` against the table, so `PromptSuggestionChips` restates its axis a second time on the icon (`size === 'compact' ? 'size-3' : 'size-3.5'`) and the two can drift. (2) `cn()`/tailwind-merge never runs over a template-literal concatenation — `path-breadcrumb.tsx:46-48` builds `labelClass` with backticks, so a caller could never override it and conflicting utilities would both reach the DOM. (3) Cross-component drift: the four filter-bar chips are one control drawn four times, and the day one grows a focus ring the other three will not.

**Recommendation.** One pass per component, no design change. Move each `Record<…, string>` into a `cva()` `variants` block and export the `componentVariants` the rule asks for. Convert the four filter-bar triggers into one `filterTriggerVariants` exported from `filter-bar/`, or better, `<Trigger asChild><Button variant="outline" size="xs">`. Convert `sheet.tsx`'s `side` last and only with an upstream-sync note — it is the one case where diverging costs future shadcn merges.

### 14.2 — `Switch` is the two-slot case ADR-0097 adopted `tailwind-variants` for, and hand-rolls four string tables instead

**P2 · M · lens 2**
`apps/client/src/layers/shared/ui/switch.tsx:7-65`

**Evidence.** Verified in source. Track and thumb both respond to one `size` axis, and the thumb's translate distance must stay in lockstep with the track's width — maintained by hand across four constants, one built by string concatenation across three breakpoints:

```ts
const RESPONSIVE_THUMB =
  'h-6 w-6 data-[state=checked]:translate-x-7 data-[state=unchecked]:translate-x-0 ' +
  'sm:h-5 sm:w-5 sm:data-[state=checked]:translate-x-5 ' +
  'md:h-4 md:w-4 md:data-[state=checked]:translate-x-4';
```

selected with `isResponsive ? RESPONSIVE_TRACK : TRACK_SIZES[resolvedSize]`. ADR-0097 names this shape precisely: "TV is used when a component has multiple DOM elements that need to respond to the same variant axes simultaneously." The ADR is accepted, `tailwind-variants` is already a dependency — and it is used in exactly **one** file in the whole client (`features/conversation/ui/message/message-variants.ts`), so the decision was implemented for `MessageItem` and never reached the primitive that needs it most. `sm`'s translate (`translate-x-3` on a `w-7` track with a `w-3` thumb) and `lg`'s (`translate-x-7` on `w-14`/`w-6`) are derived by hand and nothing checks them.

**Recommendation.** `export const switchVariants = tv({ slots: { root, thumb }, variants: { size: {…}, responsive: {…} } })`, with the responsive breakpoints as a second axis rather than an `isResponsive` boolean short-circuit. Same output, one place where a size and its travel are stated together.

### 14.3 — `Badge` is the least-finished primitive in the directory

**P2 · S · lenses 2 + 5**
`apps/client/src/layers/shared/ui/badge.tsx:3,5-29`, `apps/client/src/layers/shared/ui/index.ts:19`

**Evidence.** Verified in source. 88 JSX call sites, second only to `Button`, and it has none of the four things `Button` next door has: no `asChild` despite Radix `asChild` being the named house composition pattern (~144 uses), no `data-slot`, no exported `BadgeProps`, and a `<div>` root — so a badge inside a `<p>` is invalid HTML that React renders happily, and a badge that should be a link has to be wrapped rather than composed, which changes the layout. It also imports `cn` relatively (`../lib/utils`, see 15.9) and carries the bare `focus:ring-2` from 3.5.

**Recommendation.** Bring it to `Button`'s shape in one small PR: `asChild?: boolean` with `Slot.Root`, root element `<span>` (inline by default, which is what a badge is), `data-slot="badge"` plus `data-variant`, `export type BadgeProps` on the barrel, and `focus-visible:`. No visual change — `inline-flex` makes `span` and `div` render identically here. Add `size` only after 15.5's vocabulary lands, so it is born speaking the settled scale.

### 14.4 — `Badge` has one axis, so 71 of its 104 call sites hand-tune `className`

**P2 · M · lens 2**
`apps/client/src/layers/shared/ui/badge.tsx:5-29`; call sites incl. `features/mesh/ui/TopologyPanel.tsx:38,48,92,96` (`text-xs`), `AdapterNode.tsx:128` (`text-[10px]`), `AgentHealthDetail.tsx:117,132` (`text-[0.625rem]`), `AgentNode.tsx:100,104,109,225` (`text-[10px]`), `features/marketplace/ui/PackageTypeBadge.tsx:10-29,68-77`

**Evidence.** Verified: `badgeVariants` has exactly one axis (`variant`: default/secondary/destructive/outline) and a fixed `text-xs`. Measured across the client: **104 `<Badge` call sites, 71 of which pass `className`**, and the overwhelming majority of those overrides restate a size (`text-xs`, `text-[10px]`, `text-[0.625rem]`, `text-[11px]`) or a tone (`text-muted-foreground`, status colours, raw palette). A primitive two-thirds of its consumers have to correct is a starting point, not a primitive. The concrete cost is a type ramp the design system does not have: `text-[0.625rem]` and `text-[10px]` are the same 10px written two ways, one file apart in the same feature. `PackageTypeBadge` is the most concrete case — a `Record<MarketplacePackageType, string>` of six raw-palette triples (`blue-500/20`, `purple-500/10`, `emerald-500`, `amber-500`, `rose-500`, plus a seventh `cyan-500`), with `dark:` variants written by hand for the foreground only, so the `/10` backgrounds are not re-tuned for dark where a 10%-alpha blue over `0 0% 4%` reads very differently than over `0 0% 98%`. Its `border-<colour>/20` classes are also three more sites hit by 4.1.

**Recommendation.** Add two axes to `badgeVariants`: `size: 'xs' | 'sm'` (the two sizes that actually exist) and `tone: 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'brand'` sourced from the `--status-*` tokens that `banner.tsx:17-22` and `features/gen-ui/lib/widget-tone.ts:9-15` already map. Then sweep the 71 call sites; most collapse to `<Badge size="xs">` or `<Badge tone="warning">`. Express package types as a map to tone names, or — if six distinct identity hues are genuinely wanted for scannability in the browse grid — define them as `--package-*` tokens in `index.css` once. Either way the call site stops carrying colour literals.

### 14.5 — Nine hand-rolled icon buttons in `shared/ui` instead of composing `Button`

**P2 · M · lens 2**
`floating-panel.tsx:218-235` (two byte-identical strings 8 lines apart) · `copy-button.tsx:46-52` · `path-input.tsx:52-61` · `truncated-output.tsx:48-54` · `link-safety-modal.tsx:73-80,93-107,112-120` · `responsive-dialog.tsx:219-230` · `responsive-popover.tsx:132-135` · `filter-bar/FilterBarActiveFilters.tsx:139-146` · `features/chat/ui/chips/ChipTray.tsx:104-125`

**Evidence.** `FloatingPanel` writes the same 11-utility string twice, eight lines apart: `'text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring inline-flex items-center justify-center rounded-md p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none'`. `CopyButton` writes a near-miss of the same recipe, `PathInput`'s Browse writes a third, `LinkSafetyModal` writes three more. `Button` already encodes all of it as `variant="ghost" size="icon-sm"`, plus the responsive touch height these do not get. Nine hand-rolled icon buttons is nine places the focus ring, the disabled state and the 44px mobile floor have to be remembered — and two already forgot the floor (`copy-button.tsx` is `p-1` around a 14px glyph, ≈22px; `path-input.tsx`'s Browse is `px-3 py-2`) while two forgot `focus-visible` for bare `focus:`. `shared/ui` may import `shared/ui`: `not-found-fallback.tsx:16` and `password-input.tsx:45` already do this correctly.

**Recommendation.** Replace each with `<Button variant="ghost" size="icon-sm" aria-label=…>` (or `icon-xs` where 24px is genuinely wanted, with the `responsive={false}` opt-out stated). Where the button wraps a Radix `Close`/`Trigger`, use `asChild`. `ChipTray`'s filter toggles want `<Button variant="outline" size="xs" aria-pressed=…>` rather than their own bordered-pill string.

### 14.6 — `CollapsibleFieldCard` restates `FieldCard`'s class string instead of composing it

**P2 · S · lens 2**
`apps/client/src/layers/shared/ui/field-card.tsx:11-19` vs `:66-70`

**Evidence.** Both are exported from the same module and both write `className={cn('bg-card overflow-hidden rounded-lg border', className)}` — the same string, hand-copied. The collapsible one already composes `FieldCardContent` on line 84, so the composition is half done. The whole point of the pair is that a collapsible field card _is_ a field card; restating the frame means a change to the card's surface lands in one of two places.

**Recommendation.** `<FieldCard className={className} data-slot="collapsible-field-card">` wrapping the trigger and content. Keep the distinct `data-slot`, drop the duplicated string. Four lines.

### 14.7 — `ConnectionStatusBanner` re-implements `Banner`'s severity ladder next door, with raw palette colours

**P2 · S · lens 2**
`apps/client/src/layers/shared/ui/ConnectionStatusBanner.tsx:34-51` vs `apps/client/src/layers/shared/ui/banner.tsx:15-25,70-127`

**Evidence.** `ConnectionStatusBanner` picks between two hardcoded palette pairs with a ternary — `'bg-red-500/10 text-red-600 dark:text-red-400'` vs `'bg-amber-500/10 text-amber-600 dark:text-amber-400'` — and hand-picks the icon with a second ternary. Eleven files away, `banner.tsx` is a cva with a documented four-rung severity ladder (`critical`/`warning`/`info`/`neutral`), per-variant icons, the correct `role="alert"` vs `role="status"` split, `--status-*` tokens calibrated for both themes and the Obsidian bridge, and a dismiss slot. `design-system.md` §Banners is unambiguous that `Banner` is _the_ full-width standing-condition surface. A lost server link is textbook `critical`; reconnecting is `warning`. Worse, `ConnectionStatusBanner` announces nothing — no `role`, no `aria-live` — so a screen-reader user is never told the link dropped, which `Banner` would have supplied.

**Recommendation.** `<Banner variant={isDisconnected ? 'critical' : 'warning'} icon={isDisconnected ? WifiOff : Wifi}>`. Keep the component as the thin wrapper mapping `ConnectionState` → variant + sentence; delete the class ternary. Pairs with 19.3, which moves this file into `features/relay` where its single consumer lives.

### 14.8 — `PathInput` re-implements `Input`'s recipe minus the parts that were forgotten

**P2 · S · lens 2**
`apps/client/src/layers/shared/ui/path-input.tsx:32-48`

**Evidence.** The container copies `Input`'s border/background/shadow recipe (`dark:bg-input/30 border-input … shadow-xs transition-[color,box-shadow]`) and moves the focus ring to `focus-within:`; the inner `<input>` then re-writes the placeholder colour, the `h-11 md:h-9` responsive height and the disabled treatment by hand. What it does not carry: `aria-invalid:` styling, `selection:` colours, `file:` handling, and the `text-base md:text-sm` mobile-zoom guard. When `Input` next changes, the path field silently stops matching every other field in the app.

**Recommendation.** Keep the wrapper for the divider and Browse zone, but render `<Input>` inside it with `className="border-0 bg-transparent shadow-none focus-visible:ring-0"`, so the field's recipe stays in one file. Browse becomes `<Button variant="ghost" size="sm">`.

### 14.9 — `ResponsivePopoverContent` widens Radix's `side`/`align` unions to `string` and casts them back

**P2 · S · lens 2**
`apps/client/src/layers/shared/ui/responsive-popover.tsx:97-110`

**Evidence.** The props type is `React.ComponentPropsWithoutRef<typeof PopoverContent> & { side?: string; align?: string }`, and the render does `side={side as 'top' | 'bottom' | 'left' | 'right'}` / `align={align as 'start' | 'center' | 'end'}`. The intersection _widens_ a prop the inherited type already had right, and the casts re-narrow it without checking — so a caller writing `side="botom"` type-checks and silently gets undefined positioning. This is a primitive fighting Radix's types rather than wrapping them, and AGENTS.md §Quality Standard puts "types precise" in the non-negotiable column.

**Recommendation.** Delete the `& { side?: string; align?: string }` intersection and both casts; the inherited props are already correct. The mobile branch, which ignores them, needs no type change.

### 14.10 — `NavigationLayout` hand-rolls a tablist, a roving tabindex and a `role="toolbar"` wrapper while both replacements sit in the same folder

**P2 · L · lens 2**
`apps/client/src/layers/shared/ui/navigation-layout.tsx:164-256,304-372` vs `use-roving-tab-list.ts:84-164` and `tabs.tsx`

**Evidence.** `NavigationLayoutSidebar` wraps its `role="tablist"` in a `<div id={id} role="toolbar" onKeyDown={…}>` and implements Arrow/Home/End by querying `[role="tab"]` out of the DOM and reading `data-value` off the results. `NavigationLayoutItem` sets `tabIndex={isActive ? 0 : -1}` by hand and, on mobile, renders `<motion.button role="button">` — an explicit role a `<button>` already has. Meanwhile `use-roving-tab-list.ts`, in the same directory, implements exactly this WAI-ARIA pattern correctly, with a documented automatic-activation model, Delete-to-close and a fallback-focus contract, and is used by the desktop window-tab strip.

Three defects follow from the hand-roll: a `role="toolbar"` wrapping a `role="tablist"` is a composite widget inside a composite widget that assistive tech has no model for; the `aria-controls`/`id` wiring (`nav-item-${value}` / `nav-panel-${value}`) is global rather than scoped, so two `NavigationLayout`s on one screen collide on ids; and reading navigation order out of the DOM makes order depend on render order rather than on a list the component owns. It is also the third roving-focus implementation in the client.

**Recommendation.** In preference order: (a) have `NavigationLayoutSidebar` consume `useRovingTabList` — it already holds the ordered ids in `itemsRef`, so `getTabProps(id)` replaces the DOM query, the `tabIndex` arithmetic and the `role="toolbar"` wrapper outright; or (b) if the drill-in behaviour makes that awkward, at minimum drop the `toolbar` wrapper, scope the ids with `useId()`, and delete the redundant `role="button"`. Either way this is spec-sized — it is the settings dialog's navigation.

### 14.11 — `AgentIdentity` runs three parallel `cva()` calls keyed on one axis, plus a layout ternary

**P2 · S · lens 2**
`apps/client/src/layers/entities/agent/ui/AgentIdentity.tsx:10-50,141-149`

**Evidence.** `identityVariants` (root gap), `nameVariants` (name type) and `detailVariants` (detail type) are three separate cva definitions each declaring the same four-value `size` axis and the same `defaultVariants: { size: 'sm' }`. A fourth consequence of `size` — whether the lockup stacks — is a ternary derived from the resolved size at `:142`. Four expressions of one axis, three kept in sync by hand and the fourth invisible to the type system; adding an `xl` means editing four places and remembering the ternary. ADR-0097 named this exact shape when adopting `tv({ slots })`, and `message-variants.ts` is the working proof it reads well here. (The sibling `LoudnessMeter.tsx:10-22` documents the opposite call correctly — one slot, so cva is right there.)

**Recommendation.** One `tv({ slots: { root, label, name, detail }, variants: { size: {…} } })`, with `label`'s `flex-col` moving into the `md`/`lg` size branches so the stacking rule is stated with the sizes rather than beside them. Keep the `agentIdentityVariants` export for compatibility.

### 14.12 — `SidebarRow`'s three-state appearance is a compound-variant problem solved with conditional `&&`

**P3 · S · lens 2**
`apps/client/src/layers/shared/ui/sidebar-row.tsx:550-569`

**Evidence.** `isActive ? 'bg-sidebar-accent …' : 'text-sidebar-foreground/70 hover:…'` followed by `emphasized && !isActive && !muted && 'text-sidebar-foreground font-medium'`, plus `showSecondLine ? 'items-start py-1.5' : 'items-center'` and the `SIDEBAR_ROW_HEIGHT[pointer]` lookup. `isActive`/`emphasized`/`muted` are not three independent booleans — they are one four-valued state (`active` > `muted` > `emphasized` > `rest`), and the `&& !isActive && !muted` guard is the precedence rule written as a condition. cva's `compoundVariants` states exactly this, and `identity-avatar.tsx:154-158` and `mention-pill.tsx:70-81` already use it in this folder. P3 rather than P2 because the current code is correct and thoroughly documented; the cost is future — a fourth state means a fourth negation.

**Recommendation.** A `sidebarRowVariants` cva with axes `state` (derived once from the three props), `pointer` and `lines`, keeping `SIDEBAR_ROW_GUTTER` outside the cva since its docblock establishes it must be the last class in the merge, after the caller's `className`. Do this only alongside the `SIDEBAR_ROW_GUTTER` browser test, which is what protects the ordering.

### 14.13 — `HoverBorderGradient` takes an untyped `as` prop where `asChild` is the house pattern

**P3 · S · lens 2**
`apps/client/src/layers/shared/ui/hover-border-gradient.tsx:27,33,59`

**Evidence.** `as: Tag = 'button'` typed `React.ElementType`, spread with `React.HTMLAttributes<HTMLElement>`. `React.ElementType` erases the prop contract entirely — passing `as={Link}` type-checks and then drops every TanStack Router prop, and `onMouseEnter`/`onMouseLeave` attach to whatever the tag turns out to be. This is the onboarding CTA, the first branded moment a user sees, and therefore the component most likely to be asked to become a link.

**Recommendation.** `asChild?: boolean` + `Slot.Root`, matching `Button`. One call site to update.

---

## Batch 15 — `shared/ui` library hygiene

**Priority P1 · 14 findings · 6S · 7M · 1L**
**Scope:** the developer-facing contract of the client's most-imported public API. **15.1 is the root cause of 15.2, 15.3 and the oversized files** — land it with the backfill so the rule change and a green build arrive together. Nothing here changes a pixel.

### 15.1 — `shared/ui` is exempted from Hard Rule 4 and `max-lines` on a premise that stopped being true

**P1 · M · lens 5**
`apps/client/eslint.config.js:22-30`

**Evidence.** Verified in source:

```js
// Shadcn vendored components — exempt from max-lines and JSDoc rules
{
  files: ['src/layers/shared/ui/**/*.{ts,tsx}'],
  rules: { 'max-lines': 'off', 'jsdoc/require-jsdoc': 'off', 'jsdoc/require-description': 'off' },
},
```

The premise in the comment describes maybe 30 of the ~90 files in that directory. The rest are the client's largest hand-written public API: `SidebarRow`, `SidebarMenuNodes`, `IdentityAvatar`, `TrustDial`, `BottomSlot`, `SettingRow`, `PageContainer`, `FieldCard`, `SectionHeader`, `DataTable`, `TabbedDialog`, `NavigationLayout`, `PromptSuggestionChips`, `Feed`, `FilterBar`, `TruncatedOutput`, `BoundedNumberInput`, `PathInput`, `TrustTone`, the five `Responsive*` wrappers — none vendored, all authored here. So Hard Rule 4 ("TSDoc on exports… every jsdoc rule is `error`") and `.claude/rules/conventions.md` ("Required on… public APIs re-exported from barrel `index.ts` files") are switched off over precisely the most-imported public API in `apps/client`. The measurable consequences are 15.2, 15.3, and five files past the 500-line "must split" bar that `max-lines: warn` would have flagged: `sidebar-menu-node.tsx` (1005), `sidebar.tsx` (753), `sidebar-row.tsx` (747), `navigation-layout.tsx` (644), `identity-avatar.tsx` (563).

**Recommendation.** Narrow the carve-out to the files that are genuinely upstream shadcn and kept diff-able against it — list them explicitly rather than globbing the directory (`alert-dialog`, `dialog`, `drawer`, `dropdown-menu`, `context-menu`, `select`, `tabs`, `table`, `command`, `sheet`, `popover`, `hover-card`, `collapsible`, `sidebar`, `input-otp`) — and let Hard Rule 4 apply to everything else. Keep `max-lines` off only for the vendored list; the five oversized bespoke files then surface as `warn`, which is the intended signal, not a build break.

### 15.2 — 63 public `shared/ui` exports carry no TSDoc — the entire overlay and menu family

**P2 · M · lens 5**
`dialog.tsx` (10 exports), `alert-dialog.tsx:6,7,8,10,25,65,77,89,97`, `drawer.tsx:5,13,14,15,17,78,90`, `dropdown-menu.tsx:6,7,8,9,11,33,45,57,80,105,125,147,149`, `context-menu.tsx:7,11,17,25,29,35,59,75,93,116,142,166,183`, `select.tsx:6,7,8,16,37,73`, `tabs.tsx:5,11,26,44`, `switch.tsx:44`, `copy-button.tsx:37`, `sidebar.tsx:44`

**Evidence.** A scripted sweep of every symbol re-exported from `shared/ui/index.ts` found 63 whose declaration has no preceding doc comment. `dialog.tsx` — 20 JSX call sites for `<Dialog>` alone — has no module header and not one component doc, so hovering `<DialogContent>` shows the raw Radix type and nothing about DorkOS's own additions (the close button it injects, the `bg-black/80` overlay, the portal it opens inside). Same for `<SelectTrigger>`, `<DropdownMenuItem>` (25 call sites), `<TabsList>`, `<Switch>`. Priya reads the source; Kai reads the hover; neither gets an answer. The gap maps exactly onto the older generation of files (15.4), which is what makes it fixable in one sweep.

**Recommendation.** One PR per family (dialog + alert-dialog + drawer; dropdown + context-menu; select + tabs + switch), each adding a `@module` header plus a one-line description per export, in the voice `tooltip.tsx:6,20,25,30` and `card.tsx:4,18,25,36,47,54` already use — a sentence about what the part is _for_, not a restatement of its name. Where DorkOS deviates from upstream (Select's `responsive` prop, Dialog's injected close button), say so: that deviation is the only thing a reader cannot get from the shadcn docs.

### 15.3 — Sixteen placeholder TSDoc blocks say nothing

**P2 · S · lens 5**
`label.tsx:6-8`, `checkbox.tsx:9-11`, `separator.tsx:8-10`, `radio-group.tsx:7-9,23-25`, `slider.tsx:6-8`, `field.tsx:8,25,48,85,104,117,135,151,169,202`

**Evidence.** Each is literally `/**\n *\n */` above the declaration. `Label` has 109 JSX call sites. `Field` — ten of the sixteen — is the substrate `SettingRow` is built on and the one every settings surface composes. An empty doc block is worse than none: it occupies the slot a reader's editor shows, it defeats a grep for undocumented exports, and it reads as a fossil of a lint run that no longer applies.

**Recommendation.** Delete all sixteen and write the real sentence, or delete them and let 15.1's un-exempted rule demand one. `Field`'s ten deserve real prose: it is a compound API (`Field`/`FieldContent`/`FieldLabel`/`FieldDescription`/`FieldError`/`FieldGroup`/`FieldLegend`/`FieldSet`/`FieldSeparator`/`FieldTitle`) and which piece goes where is not guessable from the names.

### 15.4 — The library is frozen mid-migration: eight `forwardRef` files, ~20 primitives with no `data-slot`

**P2 · L · lenses 2 + 5**
Old dialect (`React.forwardRef` + `displayName`, no `data-slot`): `alert-dialog.tsx`, `dialog.tsx`, `drawer.tsx`, `dropdown-menu.tsx`, `hover-card.tsx`, `select.tsx`, `switch.tsx`, `tabs.tsx`. New dialect: `button.tsx`, `input.tsx`, `tooltip.tsx`, `scroll-area.tsx`, `card.tsx`, `checkbox.tsx`, `label.tsx`, `separator.tsx`, `skeleton.tsx`, `radio-group.tsx`, `textarea.tsx`, `sheet.tsx`, `popover.tsx`, `collapsible.tsx`, `table.tsx`, `slider.tsx`. Missing `data-slot` on the root: 42 files including `badge.tsx:28`, `setting-row.tsx:41`, `section-header.tsx:277`, `copy-button.tsx:46`, `option-row.tsx:25`, `compact-result-row.tsx:23`, `path-breadcrumb.tsx:33`, `provenance-chip.tsx:83`, `trust-dial.tsx:310`, `feed.tsx:70`, `PromptSuggestionChips.tsx:78`, `ConnectionStatusBanner.tsx:34`, `FeatureDisabledState.tsx:19`, `link-safety-modal.tsx:53`

**Evidence.** Roughly a 30/70 split. `.claude/rules/components.md` tolerates the old dialect ("Existing `forwardRef` in `ui/` is fine; don't add more") but the folder is not converging — it is frozen mid-migration, which AGENTS.md §Quality Standard names directly ("no half-finished migrations"). `data-slot` is not cosmetic: it is the styling and testing seam the newer half is built on. `field.tsx:17,56,70-71,126` selects on `has-[>[data-slot=checkbox-group]]` and `[&>[data-slot=field-label]]`; `sidebar-row.tsx:623` and the sidebar browser tests address `[data-slot="sidebar-row-title"]`; `bar-tab-strip.tsx:164`'s scrollbar hiding is implemented in `index.css` **by `data-slot` selector** because a utility class could not beat the unlayered global (the same rule as 4.1). A primitive without the attribute cannot participate in any of that, and a contributor cannot tell by looking whether the seam exists. The practical cost of the ref split is visible too: `hover-card.tsx:20-26` needed a `forwardRef` for a real reason and had to write a docblock explaining why it differs from _its own file's_ other wrappers — a comment that exists only because the baseline is ambiguous.

**Recommendation.** One migration with a definition of done. Phase 1 (S, additive, no behaviour change): add `data-slot="<kebab-name>"` to each root, and to the sub-parts of `dialog`, `drawer`, `dropdown-menu`, `select` and `tabs`, the four families where every other overlay family already has them. Phase 2 (M): drop `forwardRef`/`displayName` from the eight, since React 19 passes `ref` through props and every one spreads `...props` into a Radix primitive that forwards it; keep `displayName` only where a test asserts it. Phase 3: amend `.claude/rules/components.md` to state the finished shape once and delete the grandfather clause when nothing is left to grandfather. Do not restyle anything.

### 15.5 — Four incompatible size vocabularies, with the same word meaning three different sizes

**P2 · M · lens 5**
`button.tsx:23-32,41-42`, `switch.tsx:5,13-25`, `identity-avatar.tsx:111-119,158-162`, `copy-button.tsx:12,44`, `PromptSuggestionChips.tsx:17,20-22`

**Evidence.** Verified in source:

| Primitive               | Vocabulary                                                      | Default   | Note                                                    |
| ----------------------- | --------------------------------------------------------------- | --------- | ------------------------------------------------------- |
| `Button`                | `xs · sm · default · lg` + `icon · icon-xs · icon-sm · icon-lg` | `default` |                                                         |
| `Switch`                | `sm · default · md · lg`                                        | `default` | `md` (h-6) is **larger** than `default` (h-5)           |
| `IdentityAvatar`        | `xs · sm · md · lg`                                             | `sm`      | no `default` token at all                               |
| `CopyButton`            | `sm · md`                                                       | `sm`      |                                                         |
| `PromptSuggestionChips` | `compact · comfortable`                                         | `compact` | a deliberate, documented third axis — the correct model |

So `md` means "one step above the default" on `Switch`, "the middle of four" on `IdentityAvatar`, and "the big one" on `CopyButton`; `default` exists on two primitives and not the other three; and `IdentityAvatar` silently makes `sm` mean what `default` means everywhere else. A caller writing `<Switch size="md">` next to `<Button size="default">` gets two controls that do not line up, and nothing in either type says why.

**Recommendation.** Settle one ordinal scale — `xs · sm · md · lg` — and make `md` the default everywhere, retiring the token literally named `default`. Rename `Button`'s `default` → `md` and `icon` → `icon-md`, keeping `default`/`icon` as deprecated aliases for one release so 296 call sites do not move in one PR; rename `Switch`'s `default` → `md`, its `md` → `lg`, its `lg` → `xl`; leave `IdentityAvatar` alone (it already speaks the target vocabulary) but say in its `defaultVariants` comment that `sm` is deliberate for the sidebar's 18px slot; give `CopyButton` the full `xs|sm|md` set derived from `Button`'s icon sizes. Where a primitive's axis genuinely is not "how big", keep a named pair like `compact|comfortable` and document why, as `PromptSuggestionChips` does. No visual change ships with the rename.

### 15.6 — `responsive` is one prop name with three behaviours, and the 44px floor is spelled five ways

**P2 · M · lenses 2 + 5**
`button.tsx:44-59,64,73,85`, `input.tsx:5-6,17`, `select.tsx:10-14,24,67-71,81`, `tabs.tsx:7-9,17`, `switch.tsx:28-32,36-46`; absent from `checkbox.tsx`, `radio-group.tsx`, `textarea.tsx`, `slider.tsx`; the shared constant at `touch-target.ts:24`, consumed by `sidebar-row.tsx:34,124`, `sidebar-menu-node.tsx:38,214`, `bottom-slot.tsx:24,50`, `dashboard-sidebar/ui/{NewMenu.tsx:397,SidebarSearchPill.tsx:40,SidebarHeaderBlock.tsx:154,TodayZone.tsx:183,SidebarFooterMenu.tsx:55}`

**Evidence.** Three problems in one prop. (1) **Composition differs.** On `Button`, `Input` and `Select`, `responsive` composes with `size` (`RESPONSIVE_SIZE_CLASSES[size ?? 'default']` applied on top). On `Switch` it does the opposite — `const isResponsive = responsive && size === undefined;` — so `<Switch size="sm" responsive />` silently does nothing. The TSDoc is honest about it, but a prop that is a no-op under a condition the caller must remember is a coin flip with an invisible failure. (2) **Coverage is partial.** `Checkbox` (`size-4`), `RadioGroupItem` (`size-4`) and `Textarea` have no `responsive` prop at all, so a form built from `TextField` + `CheckboxField` + `SwitchField` grows its inputs on a phone and leaves its checkboxes at 16px. (3) **The floor has five spellings.** `touch-target.ts` exists precisely to spell it once — its doc says "One constant because the bar is one number… A shared name is what makes the next such control obvious in a diff" — and eight call sites use it, while the four primitives that most need it hardcode `h-11 md:h-9` / `size-11 md:size-9` in private tables, and `SIDEBAR_ROW_HEIGHT`/`SECTION_HEADER_HEIGHT` answer the same question a third way with a `{ fine, coarse }` record. `SelectItem`'s 44px equivalent is expressed as _padding_ while `SelectTrigger`'s is a _height_, so a compact select is compact in one half and not the other. `button.tsx:47-52` explains why it chose the CSS `md:` gate, which is a good comment — but it is a comment on one file, not a rule anyone can find from `touch-target.ts`.

**Recommendation.** Make `responsive` mean one thing everywhere: "grow this control's touch target below `md`", composing with `size` on every primitive that has it. On `Switch` that means picking the next size up (`TRACK_SIZES[nextUp(resolvedSize)]` below `md:`) rather than substituting a fixed pair. Add the prop to `Checkbox`, `RadioGroupItem` and `Textarea` with the same default so the form-field family behaves as one; where a primitive genuinely cannot grow, say so in its TSDoc so absence reads as a decision. Publish `TOUCH_TARGET_RESPONSIVE_H = 'h-11 md:h-9'` and its `size-` sibling beside `TOUCH_TARGET_MIN_H`, have the four primitives compose from it, and extend `touch-target.ts`'s module doc to state the rule once: the CSS `md:` form is for a primitive whose height is decided in CSS, the `isMobile &&` form is for a surface that already has the hook in hand, and both spend 44px. Consider renaming the axis `density: 'touch' | 'compact'` — `responsive={false}` appears six times in `filter-bar/` alone, always meaning "this is chrome, not a target", which is a named density, not a negation. No pixel moves.

### 15.7 — ~25 components' `*Props` types never reach the barrel, and four `{@link}`s point at nothing

**P2 · M · lens 5**
Unexported props types: `responsive-dialog.tsx:45` (33 call sites), `responsive-popover.tsx:33`, `responsive-sheet.tsx`, `responsive-dropdown-menu.tsx:27` (+3), `responsive-context-menu.tsx:38` (+2), `navigation-layout.tsx` (all nine), `copy-button.tsx:4`, `option-row.tsx:3`, `compact-result-row.tsx:1`, `truncated-output.tsx:7`, `feed.tsx:10`, `linkified-text.tsx:223`, `markdown-content.tsx`, `markdown-link.tsx`, `path-breadcrumb.tsx:3`, `progress.tsx`, `bar-tab-strip.tsx`, `sidebar-menu-node.tsx:540,880`, `sonner.tsx`, `DirectoryPicker.tsx:50`, `FeatureDisabledState.tsx:4`, `ScanLine.tsx:3`, `ConnectionStatusBanner.tsx`, `markdown-error-boundary.tsx:3`. Dangling links: `sidebar-row.tsx:257` → `SidebarMenuSurfaceProps`, `:95` → `SIDEBAR_MENU_GUTTER`, `:722` → `SIDEBAR_MENU_ITEM_ATTRS`, `feed.tsx:33` → `FeedBeyondRenderedHandler`

**Evidence.** `.claude/rules/fsd-layers.md` mandates barrel-only imports and a deep import is an ESLint `error`, so a consumer who wants `function MyDialog(props: ResponsiveDialogProps)`, or a typed `DataTableGrouping` factory, has two options: redeclare the shape by hand, or reach for `React.ComponentProps<typeof X>` and hope the component is not destructuring away props it does not forward. The library is inconsistent about it — `ButtonProps`, `InputProps`, `SwitchProps`, `BannerProps`, `PageContainerProps`, `SettingRowProps`, `DataTableProps`, `SidebarRowProps` and ~15 others _are_ on the barrel — so the omissions read as accidents rather than encapsulation. Meanwhile `sidebar-row.tsx:257` writes `{@link SidebarMenuSurfaceProps.onMenuIntent}`, a link that resolves to nothing outside the directory.

**Recommendation.** Add the missing `export type` lines to `shared/ui/index.ts` — mechanical and zero-risk. Export `DataTableGrouping` alongside `DataTableProps` (it is the type of a public prop) and `SidebarMenuSurfaceProps` alongside `SidebarMenuSurface`. Fix the four dangling links: two by exporting their targets, `feed.tsx:33` by qualifying it as coming from `shared/model`. Consider a small vitest guard that fails when a barrel-exported component's `*Props` interface is not also exported, so the class cannot regrow.

### 15.8 — Six visual leaves accept no `className`, and two siblings extracted in the same change disagree about it

**P2 · S · lenses 2 + 5**
`compact-result-row.tsx:1-12,23-26`, `option-row.tsx:3-14,25-31`, `path-breadcrumb.tsx:3-12,33`, `settings-panel.tsx:4-12`, `FeatureDisabledState.tsx:4`, `trust-dial.tsx:169`; contrast `truncated-output.tsx:12`

**Evidence.** `.claude/rules/components.md` states the rule — "`cn()` … for all conditional/merged classes; caller `className` goes last so it can override" — and it holds across most of the library. The sharpest evidence is a pair extracted in the same change and exported from adjacent barrel lines (`index.ts:385-388`): `truncated-output.tsx:12` documents the contract (`/** Chrome for the wrapper — margins, borders. The caller owns it. */`), while `compact-result-row.tsx:24` hardcodes its whole surface (`bg-muted/50 rounded-msg-tool shadow-msg-tool border px-3 py-1 …`) and works around the omission with an index-signature hack (``[key: `data-${string}`]: string | undefined``) so that _only_ data attributes get through. `OptionRow` takes `isSelected`, `isFocused`, `control`, `children` and a `'data-selected'?: boolean` — nothing else, so the caller cannot pass a margin, a `data-testid`, a ref or an `id`, and `isSelected` + `data-selected` is the same fact taken twice. `PathBreadcrumb` has neither `className` nor a spread and builds its classes with template literals, so `cn()`/tailwind-merge never runs. Both `CompactResultRow` and `OptionRow` are drawn by two different surfaces (the transcript and the Ask card, per the barrel's own comment), and neither surface can give them a margin. A shared leaf that cannot be positioned by its host is the leaf the next host copy-pastes instead of importing.

**Recommendation.** Give all six `React.ComponentProps<'div'>` (or `'span'`) with `className` last in the `cn()` and `{...props}` on the root. Delete `CompactResultRow`'s index-signature workaround and `OptionRow`'s duplicate `data-selected` (derive it from `isSelected`); replace `PathBreadcrumb`'s template literals with `cn()`. `SettingsPanel` should forward it too — it is a `NavigationLayoutPanel` wrapper and the panel takes one. Copy `TruncatedOutput`'s one-line prop doc as the wording.

### 15.9 — `cn` is imported three ways, and the mandated spelling drags the transport into a leaf primitive

**P2 · M · lens 5**
`@/layers/shared/lib/utils` in 30 files, `../lib/utils` in 24 (including `badge.tsx:3`, `card.tsx:2`, `switch.tsx:3`, `select.tsx:4`, `dialog.tsx:4` — verified), `@/layers/shared/lib` (the barrel) in 27; supporting evidence at `apps/client/src/layers/shared/lib/index.ts:287-291`

**Evidence.** `.claude/rules/fsd-layers.md` §Import Conventions says two things — always the `@/` alias, always the module's `index.ts` — and only 27 of 81 files obey both. But obeying both has a cost the barrel itself documents: `shared/lib/index.ts:287` explains that `overnightBoundary` is deliberately _not_ re-exported because one of its callers "a source-level contract forbids from value-importing this barrel at all (it pulls in the transport, the sound player and a dozen other side effects)". The barrel is 298 lines re-exporting ~150 symbols from ~60 modules, including `HttpTransport`, `playCelebration`, `CelebrationEngine` and `queryClient`. So `import { cn } from '@/layers/shared/lib'` inside a 20-line `OptionRow` pulls a module graph that has nothing to do with class merging — very likely why 24 files quietly reach for `../lib/utils`. Three spellings of the most-imported helper in the client is a coin flip on every new file, and the "correct" one per the written rule is the one with a side-effect cost the same codebase elsewhere treats as disqualifying.

**Recommendation.** Decide once and enforce once. The defensible answer for `shared/ui` internals is the **leaf module path** — `@/layers/shared/lib/utils` — because it is side-effect-free, still the `@/` alias, and already the plurality. Normalise all 81 files, then amend `.claude/rules/fsd-layers.md` with the carve-out in one sentence: _within `shared/`, import leaf modules directly; the barrel is the contract for consumers in `entities/`, `features/` and `widgets/`._ A `no-restricted-imports` rule scoped to `src/layers/shared/**` can hold it. Splitting `shared/lib`'s barrel so a value import does not reach the transport is worth doing, but it is its own spec.

### 15.10 — `CopyButton`'s documentation is attached to the wrong function, and its `<button>` has no `type`

**P2 · S · lens 5**
`apps/client/src/layers/shared/ui/copy-button.tsx:15-22,37,46`

**Evidence.** The file has two doc blocks one function apart: the paragraph explaining the component ("Icon button that copies a string to the clipboard with timed inline feedback…", including the non-obvious fact that its defaults are tuned for Settings dialogs) sits above `CopyButtonIcon`, immediately followed by the icon's own one-liner — which wins in an editor. The exported `CopyButton` (13 call sites) documents nothing. Separately, `:46` renders a bare `<button>` with no `type`, so it would submit any form it lands in.

**Recommendation.** Move the `:15-21` block down onto `CopyButton` at `:37`, leave the icon's one-liner where it is, add `type="button"`, and export `CopyButtonProps` from the barrel (15.7).

### 15.11 — `input-otp.tsx` is dead code with a live dependency

**P2 · S · lens 5**
`apps/client/src/layers/shared/ui/input-otp.tsx`, `apps/client/package.json:74`

**Evidence.** Verified: it is the only file in `shared/ui` not re-exported from `index.ts`, a repo-wide grep for `InputOTP`/`input-otp` outside the file itself returns nothing, and `input-otp@^1.5.0` is still a runtime dependency. AGENTS.md §Quality Standard: "no dead code… when something is superseded, remove it." It is also a trap — the one file whose only importable path is a deep import, which ESLint rejects, so the next contributor who finds it must modify the barrel before using it and cannot tell whether the omission was deliberate.

**Recommendation.** Delete the file and drop the dependency. If OTP entry lands on the roadmap, the shadcn generator re-adds it in one command when a caller exists.

### 15.12 — The `entities/session` barrel publishes two hooks that share a name upstream

**P2 · S · lens 5**
`apps/client/src/layers/entities/session/index.ts:38-39,65-76`

**Evidence.** `export { useSessionStatus } from './model/use-session-status';` at `:38`, and inside the session-chat-store block at `:69`, `useSessionStatus as useSessionChatStatus`. Two different hooks, both named `useSessionStatus` in their own modules, both on one barrel, distinguished only by an alias — and nothing on the barrel says what the difference is (one reads the session's server-side status, the other the per-session chat store's). Autocomplete offers both with identical prefixes. This barrel is otherwise exemplary, carrying a genuine comment for nearly every non-obvious export; the one place a reader is most likely to pick the wrong symbol is the one place with no note.

**Recommendation.** Add a two-line comment above the alias saying which question each hook answers, in the voice the rest of the file uses. Better still, rename at the source — `useSessionChatStatus` in `session-chat-store.ts` and `useSessionServerStatus` in `use-session-status.ts` — so the alias disappears and the barrel is a straight re-export.

### 15.13 — `Button` and ~20 bare `<button>`s in `shared/ui` do not default `type="button"`

**P3 · S · lens 5**
`apps/client/src/layers/shared/ui/button.tsx:76-89`; bare elements with no `type`: `copy-button.tsx:46`, `truncated-output.tsx:48`, `path-breadcrumb.tsx:59`, `link-safety-modal.tsx:93`, `navigation-layout.tsx:343`, `responsive-dropdown-menu.tsx:262,334`, `route-error-fallback.tsx:65`, `app-crash-fallback.tsx:87,105`, `DirectoryPicker.tsx` (11 sites)

**Evidence.** `Button` renders `<Comp data-slot="button" …>` with no default `type`, so an HTML `<button>` inside a `<form>` defaults to `type="submit"`. A scripted check found **no** current instance of a `Button` inside a `<form>` without an explicit type — 15 call sites write `type="submit"` deliberately and the 39 `<form>` elements are clean — so nothing is broken today. It is "hard to misuse" failing preventively: the next `<Button onClick={…}>` added inside a form submits it silently, and the bug presents as "the dialog closes when I click Cancel".

**Recommendation.** Default `type` in `Button` when it renders a real `<button>`: `{...(asChild ? {} : { type: props.type ?? 'button' })}`, leaving `asChild` alone (the slotted child owns its element). Add `type="button"` to the bare elements listed. Keep the 15 explicit `type="submit"` call sites exactly as they are — they mean it.

### 15.14 — The public "work is happening" animation is named after an unrelated product surface

**P3 · M · lens 5**
`apps/client/src/index.css:841-875` (`@keyframes tasks`, `@utility animate-tasks`), `apps/client/src/layers/shared/ui/skeleton.tsx:8`

**Evidence.** `Skeleton` — 112 JSX call sites, the client's second most-used primitive — is `cn('bg-accent animate-tasks rounded-md', className)`. The CSS comment calls it "The 'work is happening' breath, worn by ~20 call sites (ThinkingBlock, MemoryRecallBlock, loading skeletons, connection dots)" and explains at length why it is opacity-only. The name says none of that, and "tasks" is already the name of a product surface (`/tasks`, `entities/tasks`, Pulse schedules), so a reader of `skeleton.tsx:8` reasonably concludes the skeleton is task-related. A class name is API; this one is used across three layers and actively misleads about both what it does and what domain it belongs to.

**Recommendation.** Rename the keyframe and utility to `breath`/`animate-breath` — it is already described as "a faster, quieter cousin of `breathe`" — move the explanatory comment with it, and update the ~20 call sites in one mechanical PR. Keep `animate-tasks` as an alias for one release only if an e2e selector depends on the class string; otherwise delete it.

---

## Batch 16 — Docs and discoverability

**Priority P2 · 7 findings · 4S · 3M**
**Scope:** documentation only, no code renders differently. These are the reasons contributors keep making the mistakes the other batches clean up: the ground-truth docs teach a dead import path, contradict each other on reduced motion, and describe a naming convention the directory does not follow.

### 16.1 — A live contributing guide teaches the wrong pattern and a non-existent import path

**P2 · S · lens 5**
`contributing/styling-theming.md:381-395`, `contributing/design-system.md:1071`

**Evidence.** `styling-theming.md` presents this as the ✅ pattern:

```tsx
// ❌ Don't modify Shadcn component source files
// ✅ Use className prop or create wrapper
import { Button as BaseButton } from '@/components/ui/button';
```

`@/components/ui/button` has not existed since the FSD migration — `apps/client/src/components/` is not a directory — so an agent copying that line writes an import that fails both `tsc` and the FSD lint rule. Worse, the advice contradicts the repo's actual practice and its own rules: `.claude/rules/components.md` §Required Patterns says to follow the existing files and add `cva` variants, and `button.tsx:19-20` carries a bespoke `brand` variant while `:41-59` carries a bespoke `responsive` system — the file has been modified heavily and on purpose. `design-system.md:1071` has the same stale path ("See `components/ui/responsive-dialog.tsx`"). These two files are the ground truth an agent reads before touching a primitive; teaching "wrap, don't modify" is how a `BaseButton`-wrapper layer gets born on top of a design system built to be extended in place.

**Recommendation.** Rewrite `styling-theming.md:381-395`: shadcn files here are **owned**, not vendored; extend them with a new `cva` variant and keep the caller `className` escape hatch for one-offs; never fork a primitive into a wrapper. Fix both stale paths to `apps/client/src/layers/shared/ui/…`. Add a grep for `@/components/` to the docs check so a dead path cannot come back.

### 16.2 — `shared/ui` documents one naming convention and ships a second one, undocumented

**P2 · M · lens 4**
`.claude/rules/components.md:107`, `contributing/project-structure.md:416`; outliers `apps/client/src/layers/shared/ui/{ConnectionStatusBanner,DirectoryPicker,FeatureDisabledState,PromptSuggestionChips,ScanLine}.tsx`, plus `shared/ui/filter-bar/` (8 files) and `shared/ui/form-fields/` (7 files), all PascalCase

**Evidence.** Both docs state the file-naming rule as a flat table — "Component file → PascalCase (`UserCard.tsx`)" — and neither carves out `shared/ui/`. The real barrel is the opposite: 85 of 90 files are kebab-case (`button.tsx`, `data-table.tsx`, `mention-pill.tsx`, `sidebar-row.tsx`, `trust-dial.tsx` — none of these are shadcn scaffolding, they are hand-built DorkOS components, kebab-cased anyway). Five top-level files and two whole subdirectories break it. The drift is live, not legacy: all five top-level outliers were added in the last five weeks (four on 2026-07-29 in PR #606, one on 2026-08-08 in PR #880) by whoever reached for the documented rule in good faith. `shared/ui/tour-spotlight/` gets it right by the shared/ui norm — component files PascalCase, hook files kebab — proving the split convention is achievable and was achieved once.

**Recommendation.** Pick one and write it down. The cheap fix is documenting what is already true: one line in `.claude/rules/components.md`'s File Naming table — "`shared/ui/` is the exception: files are kebab-case regardless of shadcn-vs-custom origin." That alone stops the bleeding on new files. Renaming the seven existing outliers is optional cleanup on top, and cheap — no runtime behaviour changes, only the barrel's `from './…'` paths move with the files.

### 16.3 — One usage example in ninety primitives

**P3 · M · lens 5**
`apps/client/src/layers/shared/ui/filter-bar/index.ts:4-14` (the only `@example` in `shared/ui`; seven in the whole client)

**Evidence.** `FilterBar`'s barrel opens with a compact, complete example showing the compound shape in ten lines. Nothing else in the library has one — not `NavigationLayout` (nine sub-components), not `TabbedDialog`, not `SidebarMenuNodes`, not `ResponsiveDialog`, not the `Field` family. For a compound API the example _is_ the documentation: prose describing `Field`/`FieldContent`/`FieldLabel`/`FieldDescription` nesting is strictly worse than four lines of JSX, and the example is what both an editor hover and an agent's context window surface.

**Recommendation.** Add one `@example` to each compound primitive's root export — `NavigationLayout`, `TabbedDialog`, `Field`, `Card`, `ResponsiveDialog`, `SidebarMenuNodes`, `DataTable`, `Feed`. Keep each to the shortest thing that compiles; a long example rots. Pairs naturally with batch 20 — the playground showcase and the `@example` should show the same shape.

### 16.4 — Two of the five responsive wrappers are undocumented

**P3 · S · lens 5**
`contributing/design-system.md:1005-1075`; undocumented: `apps/client/src/layers/shared/ui/responsive-sheet.tsx` (14 call sites), `responsive-context-menu.tsx`

**Evidence.** The section is good where it exists: `:1011` gives the choose-this-not-that rule for `ResponsiveDropdownMenu` ("Use instead of plain `DropdownMenu` when the menu appears in a touch-accessible area… Plain `DropdownMenu` is fine for desktop-only contexts") and `:1075` does the same for `ResponsivePopover`. `ResponsiveSheet` and `ResponsiveContextMenu` get no entry, so the only way to learn they exist is to read the barrel.

**Recommendation.** Add the two missing subsections in the same shape as the existing three — a one-line "use instead of X when…" plus the desktop/mobile mapping table — and fix the stale path at `:1071` (16.1). While there, put the one-line rule in each wrapper's own TSDoc with an `@see` back to the plain primitive, so the choice is answerable from the editor as well as the guide.

### 16.5 — Ninety exports and no map

**P3 · M · lens 5**
`apps/client/src/layers/shared/ui/index.ts` (389 lines, 90 modules); the families it exposes — overlays (`dialog`/`responsive-dialog`, `popover`/`responsive-popover`, `dropdown-menu`/`responsive-dropdown-menu`, `context-menu`/`responsive-context-menu`, `sheet`/`responsive-sheet`/`drawer`) and rows (`sidebar-row`, `setting-row`, `option-row`, `compact-result-row`, `sidebar-menu-node`, plus `entities/session`'s `SessionRow`/`SessionRowSidebar`)

**Evidence.** There is no `README.md` anywhere under `apps/client/src/layers/`. The barrel is the only index, it is not alphabetised (`Progress` and `PromptSuggestionChips` land between `Collapsible` and `Input`), and its section comments cover four of ninety modules. `design-system.md` answers the overlay question for three of five pairs and does not touch the row family at all — so a contributor asking "which row do I use for a settings toggle vs a sidebar entry vs a decided prompt option?" has seven candidates and no guide. Discoverability is the first DX property: a library you cannot navigate gets re-implemented instead of imported, which is the upstream cause of most of batch 17.

**Recommendation.** Add `apps/client/src/layers/shared/ui/README.md` — one page, three tables (overlays, rows, form controls), each row _"want X → use Y; not Z, because…"_ — and link it from `contributing/design-system.md` and `.claude/rules/components.md`. Then group the barrel with section comments matching the README's sections and alphabetise within each group. Documentation and ordering only.

### 16.6 — Two composition idioms for compound components

**P3 · S · lens 5**
`apps/client/src/layers/shared/ui/filter-bar/index.ts:27-34` (namespace via `Object.assign`) vs `card.tsx:65`, `dialog.tsx`, `field.tsx`, `navigation-layout.tsx`, `sidebar.tsx`, `table.tsx` (flat sibling exports)

**Evidence.** `FilterBar` is reached as `<FilterBar.Search>`, `<FilterBar.Sort>`; every other multi-part primitive is reached as `<CardHeader>`, `<DialogContent>`, `<FieldLabel>`. `FilterBar` is the sole `Object.assign` compound in `layers/`. Not wrong — the namespace form is arguably nicer and tree-shakes fine — but a contributor building the next compound has no default, and a reader scanning imports sees one name for `FilterBar` and seven for `Card`.

**Recommendation.** Pick the flat sibling form as the house style (it is the shadcn convention the other 89 files follow), write the choice down in one sentence in `.claude/rules/components.md`, and leave `FilterBar` as it is with a note that it predates the rule — churning 16 call sites to win consistency alone is not worth it. Revisit only if a second namespace compound appears.

### 16.7 — The two ground-truth docs give opposite instructions on reduced motion for `motion/react`

**P3 · S · lens 10**
`contributing/animations.md:621-635,765-767` versus `contributing/design-system.md:609`

**Evidence.** `animations.md` says reduced motion "is handled globally — no per-component work required… **No per-component `useReducedMotion` calls are needed**". `design-system.md:609` says "The one thing the reset does not reach is `motion/react`, which writes inline styles from JS: **any `motion.*` component must call `useReducedMotion()` and branch off**." The codebase splits accordingly: ~60 files call the hook, ~150 rely on `MotionConfig reducedMotion="user"` alone. Both are half right, and the half nobody wrote down is the one that matters: `MotionConfig reducedMotion="user"` suppresses **transform and layout** animations but not **opacity or colour**. So an infinite opacity or colour loop written in `motion/react` keeps running under `prefers-reduced-motion` regardless of the global config. The app currently gets this right by convention (`use-session-border-state.ts:147-168` gates its infinite `borderLeftColor` pulse; `LaneContent.tsx:503-505` gates its infinite sweep) — but an author following `animations.md` literally would not. This is the doc half of 18.14.

**Recommendation.** Reconcile into one sentence with the actual mechanism: _transform and layout animations are handled by `MotionConfig`; opacity, colour and any `repeat: Infinity` animation need an explicit `useReducedMotion()` gate, and the gate belongs in a pure function that also reports itself as a `data-` attribute_ (the `shouldAnimateRoster()` shape, `design-system.md:624`). Doc-only; no code moves.

---

## Batch 17 — Componentization: extract what's been copied

**Priority P2 · 12 findings · 5S · 7M**
**Scope:** the repo's own three-strike DRY rule (`.claude/rules/conventions.md`), applied. Each finding names the shared thing to build and the call sites to migrate. Several depend on batch 14 landing first (the `Badge` shape variant in particular).

### 17.1 — Seven independent empty-state components; no shared `EmptyState`

**P2 · M · lenses 3 + 12**
`apps/client/src/layers/features/mesh/ui/MeshEmptyState.tsx:18-45`, `mesh/ui/TopologyEmptyState.tsx:12-28`, `marketplace/ui/PackageEmptyState.tsx:34-58`, `activity-feed-page/ui/ActivityEmptyState.tsx:44-61`, `relay/ui/RelayEmptyState.tsx`, `tasks/ui/TasksEmptyState.tsx`, `chat/ui/ChatEmptyState.tsx`

**Evidence.** A `grep -rn "export function.*EmptyState"` over `layers/` turns up no `shared/ui` entry at all — every one was built from scratch in its own feature slice. At least four are structurally identical (icon, bold one-line headline, muted description, optional `<Button>` CTA) with drifting details:

|                      | icon wrapper                    | headline                           | gap/padding                |
| -------------------- | ------------------------------- | ---------------------------------- | -------------------------- |
| `ActivityEmptyState` | `bg-muted rounded-full p-4`     | `text-sm font-medium`              | `gap-3 py-16`              |
| `MeshEmptyState`     | `bg-muted/50 rounded-xl p-3`    | `text-sm font-medium`              | `gap-3 p-12`               |
| `TopologyEmptyState` | none (bare icon, `/50` opacity) | `text-sm font-medium` (`<h3>`)     | `gap-3` (no fixed padding) |
| `PackageEmptyState`  | none (bare icon)                | `text-base font-semibold` (`<h3>`) | `border-dashed py-16`      |

`MeshEmptyState` is already the generic shape the charter describes (`icon: LucideIcon`, `headline`, `description`, optional `action`, optional `preview`) and `DeniedView.tsx:1-30` already reuses it across a sibling feature — it just stayed scoped to `features/mesh/` instead of moving to `shared/ui`, so everyone else reinvented it.

**Recommendation.** Promote `MeshEmptyState`'s shape to `shared/ui` as `EmptyState`, keeping the `preview` slot, and migrate `TopologyEmptyState`, `PackageEmptyState` and `ActivityEmptyState`'s two internal variants onto it, deleting the bespoke wrappers. Leave `ChatEmptyState`, `TasksEmptyState` and `RelayEmptyState` as feature-owned compositions — they carry genuinely bespoke content (state-machine branching, a template gallery, a ghost message-log preview) — but let them compose the shared primitive for their footer. This also gives batch 20 one place to showcase "empty state" instead of four.

### 17.2 — Four page-level widgets hand-roll the identical "couldn't load, retry" state

**P2 · M · lens 12**
`apps/client/src/layers/widgets/tasks/ui/TasksPage.tsx:84-97`, `widgets/team/ui/TeamPage.tsx:116-129`, `widgets/team/ui/TeamRoute.tsx:96-109`, `features/feedback-requests/ui/FeedbackRequestsPanel.tsx:142-158`

**Evidence.** Verified in source (TeamPage read in full). All four share the exact same outer class (`flex h-full flex-col items-center justify-center gap-3 p-8 text-center`), the same icon wrapper (`bg-destructive/10 rounded-xl p-3` around a `TriangleAlert` at `size-6`), the same two-line structure (`text-sm font-medium` headline + `text-muted-foreground text-xs` line), and the same `Button size="sm" onClick={() => void refetch()}`. Only the two lines of copy differ. Even the Tailwind class order is identical — copy-paste, not coincidental resemblance. A fifth query-error surface will copy the fourth, because there is nothing to reach for.

**Recommendation.** Extract `QueryErrorState` in `shared/ui` taking `title`, `description` and `onRetry`, and swap all four onto it. Effort is small per call site but crosses widget/feature boundaries, so scope it as one slice. 6.4 is the fifth consumer waiting to be written.

### 17.3 — Four features independently invented the same "label left, value right" row

**P2 · M · lens 12**
`apps/client/src/layers/features/agent-settings/ui/McpServerCardDetails.tsx:19-23` (`DetailRow`), `features/status/ui/UsageStatusItem.tsx:26-33` (`DetailRow`), `features/status/ui/SessionInspector.tsx:304-340` (`Row`), `entities/session/ui/SessionDetailsPanel.tsx:146-161` (`DetailRow`)

**Evidence.** Four names for one idea (three `DetailRow`, one `Row`), four different alignment strategies for the same two columns — `grid grid-cols-[5.5rem_1fr]`, `flex justify-between gap-3`, `flex items-baseline gap-2`, `flex items-start gap-2` with a fixed `w-16` label — and four different subsets of the features a detail row plausibly needs: `SessionInspector` adds `wrap`, `indent` and `swatch`; `SessionDetailsPanel` adds `copyable` rendering a `CopyButton`; neither of the other two has any. Each feature re-derived its own subset instead of inheriting the union. `shared/ui` has `field.tsx`/`field-card.tsx`/`setting-row.tsx` for form-oriented label/control pairs but nothing for read-only label/value display, so every panel that needed one wrote its own.

**Recommendation.** Design one `DetailRow` (or `KeyValueRow`) in `shared/ui` that is the union of the four call sites' props (`label`, `value`/`children`, `wrap`, `indent`, `swatch`, `copyable`, `valueClassName`), then migrate all four. This is the highest-value extraction in this batch: it removes real, currently-diverging duplication rather than pre-emptively unifying things that merely look alike.

### 17.4 — Four `rounded-full` pill components duplicate the badge shell instead of composing `Badge`

**P2 · M · lenses 3 + 12**
`apps/client/src/layers/entities/activity/ui/ActorBadge.tsx:30-42`, `entities/activity/ui/CategoryBadge.tsx:20-32`, `entities/marketplace/ui/ScopeBadge.tsx:28-39`, `entities/room/ui/BridgeVisibilityBadge.tsx:71-74`, `features/activity-feed-page/ui/ActivitySinceLastVisit.tsx:126`; compare `apps/client/src/layers/shared/ui/badge.tsx:5-19`

**Evidence.** The shared `badgeVariants` shell is `inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium`. None of these import `Badge` — each hand-writes its own version with small unexplained drift: `CategoryBadge` `rounded-full px-2 py-0.5`, `ScopeBadge` `rounded-full px-1.5 py-0.5 text-[9px] … uppercase`, `ActorBadge`'s neutral variant `rounded-full border px-2 py-0.5 text-xs`, `BridgeVisibilityBadge` `h-6 … rounded-full border px-2.5 text-[11px]`. Four slightly different pill geometries, none of them the actual component. The reason is structural: `Badge` only ships `rounded-md`, so the pill shape every one of these wanted is not available from the primitive. Each also maintains its own colour-variant lookup (`ACTOR_CONFIG`, `CATEGORY_CONFIG`, `SCOPE_CLASSES`), so a future change to the pill's vertical padding — lens 8's territory — means editing four files that never call `<Badge>`.

**Recommendation.** Add a `shape: 'default' | 'pill'` variant to `badgeVariants` (pairs with 14.4's `size`/`tone` axes), then have `CategoryBadge`, `ScopeBadge`, `ActorBadge`'s neutral case and `ActivitySinceLastVisit` render `<Badge shape="pill" className={colorClass}>`, keeping their domain config maps untouched. `BridgeVisibilityBadge` is a disclosure trigger styled as a label — its own doc is explicit it must never look like a `Badge` — so leave it a `<button>`, but let it pull its shell classes from the same `badgeVariants({ shape: 'pill' })` output.

### 17.5 — About ten files hand-roll the `Card` shell instead of importing `Card`

**P2 · M · lens 12**
Read in full: `apps/client/src/layers/features/connections/ui/ProviderSetupCard.tsx:48`, `connections/ui/ClaimCard.tsx:114`, `extensions/ui/ExtensionCard.tsx:64`. Grep-matched, same shell: `features/mesh/ui/AgentNode.tsx`, `marketplace/ui/PackageLoadingSkeleton.tsx`, `gen-ui/ui/WidgetSkeleton.tsx`, `gen-ui/ui/WidgetErrorCard.tsx`, `connections/ui/{AgentAccounts,AccountsList,ServiceGrid,AccountsFirstRun}.tsx`, `notifications/ui/PermissionPrimer.tsx`, `onboarding/ui/OnboardingWidgetCard.tsx`

**Evidence.** `shared/ui/card.tsx:5-16` defines `Card` as exactly `bg-card text-card-foreground shadow-soft flex flex-col gap-4 rounded-lg border p-4`. `ProviderSetupCard.tsx:48` is a bare `<div className="bg-card rounded-lg border p-4">` — the same classes minus `shadow-soft`/`gap-4`/`text-card-foreground` — on a plain div. `ClaimCard.tsx:114` is the same idea with `shadow-soft` added back by hand. `ExtensionCard.tsx:64` imports `Badge`, `Button` and `Switch` from `shared/ui` on line 4 and still hand-writes `'bg-card rounded-xl border p-4'` for its own shell. This is the clearest "ad-hoc reimplementation of something `shared/ui` already solves" in the audit: the component exists, is imported for its siblings in the same file, and is skipped for the one job it does.

**Recommendation.** Sweep the ~10 hits and swap the outer wrapper for `<Card>` (with `CardContent`/`CardFooter` where the structure already separates body from actions). Where a file genuinely wants `rounded-xl` instead of `rounded-lg`, that is a signal `Card` is missing a `size`/`radius` variant — add it via cva, matching the pattern every other primitive in the folder uses, rather than a reason to keep reimplementing. While adding variants: `Card` has no cva axes at all despite `design-system.md` documenting a `card-interactive` utility specifically for it, and only 4 files in the whole client apply that utility — a `variant: 'static' | 'interactive'` wiring it in would make the hover affordance reachable from the primitive (see 5.6).

### 17.6 — Three feature-promo dialogs are the same layout, copy-pasted three times

**P2 · S · lens 12**
`apps/client/src/layers/features/feature-promos/ui/dialogs/SchedulesDialog.tsx:15-32`, `RelayAdaptersDialog.tsx:15-33`, `AgentChatDialog.tsx:14-32`

**Evidence.** All three import `PromoDialogProps` from `../../model/promo-types` and render, in order: (1) a `flex items-center gap-3` header with a `size-10` icon badge in a `rounded-lg bg-gradient-to-br from-{color}-500/10 to-{color}-600/10` box next to an `h3 text-sm font-medium` + `p text-muted-foreground text-xs` pair; (2) a `bg-muted/50 space-y-3 rounded-lg p-4` box with exactly two `flex items-start gap-3` bullets, each icon + `text-xs font-medium` title + `text-muted-foreground text-xs` description; (3) a `flex justify-end gap-2` footer with a ghost dismiss and a primary CTA. Only the icons, the gradient colour (indigo/purple/emerald) and the copy differ. This is 3-for-3 — every promo dialog that exists follows the identical layout, in a `dialogs/` directory with a shared props type designed for growth — so the fourth will be a fourth copy-paste. (The gradient icon badge is also worth a look against `design-system.md`'s "Purple/brand gradients" anti-pattern; flagged here only as a byproduct.)

**Recommendation.** Extract `PromoDialogLayout` (`icon`, `iconTint`, `title`, `subtitle`, `highlights: {icon, title, description}[]`, `primaryAction`, `secondaryAction`) in `features/feature-promos/ui/`, and rewrite all three as data passed to it. A fourth promo dialog then costs a data literal instead of 30 lines of re-typed markup.

### 17.7 — The inline session-rename state machine is copy-pasted across all three `SessionRow` variants

**P2 · S · lens 3**
`apps/client/src/layers/entities/session/ui/SessionRowCompact.tsx:32-81`, `SessionRowSidebar.tsx:116-179`, `SessionRowFull.tsx:39-95`

**Evidence.** All three define the identical five-piece machine: `isRenaming`/`setIsRenaming`, `renameValue`/`setRenameValue`, a `committedRef` guard so a commit followed by the resulting blur does not double-fire, a `useEffect` that `requestAnimationFrame`s focus onto the input specifically to beat Radix's focus restoration after a context menu closes, and `startRename`/`commitRename`/`cancelRename` with the same trim-and-no-op-if-unchanged logic and the same Enter/Escape mapping. Same variable names, same guard, three times. The `requestAnimationFrame` focus-steal comment — a genuinely non-obvious fact — is duplicated near-verbatim in all three files, because the logic that needed explaining was pasted three times. `SessionRowSidebar` adds a real, small variation worth preserving (an `endRename()` that also restores focus to the row).

**Recommendation.** Extract `useInlineRename({ initialValue, onCommit })` into `entities/session/model/`, returning `{ isRenaming, renameValue, setRenameValue, inputRef, start, commit, cancel, handleKeyDown }`. Let `SessionRowSidebar` layer its extra focus restoration on top via a passed `onEnd`.

### 17.8 — Fifteen hand-rolled height-collapse transitions at three durations, under three local names

**P2 · M · lens 10**
`features/chat/ui/tools/ToolCallCard.tsx:66` (0.2s), `chat/ui/input/QueuePanel.tsx:69` (0.2s, no easing), `features/tasks/ui/TaskBuilder.tsx:71` (`ANIMATION_TRANSITION`, 0.2s, used at `:395,425,462`), `chat/ui/message/ErrorMessageBlock.tsx:9` (`collapseTransition`, 0.25s), `features/ask/ui/QuestionPrompt.tsx:12` (`collapseTransition`, 0.25s — a byte-identical second definition), `features/tasks/ui/TaskRow.tsx:339` (0.3s), `chat/ui/primitives/CollapsibleCard.tsx:86` (0.3s), plus inline variants in `settings/ui/{TunnelSettings.tsx:10,TunnelSetup.tsx:8,TunnelConnected.tsx:37}` and `chat/ui/tasks/{TaskDetail.tsx:92,TaskDetailPanel.tsx:20,TaskActiveForm.tsx:16,TaskListPanel.tsx:77}`

**Evidence.** Fifteen call sites hand-roll the same three-line variant object for the same gesture (`height: 0 ↔ 'auto'` plus opacity). Durations are 200ms, 250ms and 300ms depending on which file you land in, and two files declare an identically named `collapseTransition` constant independently. `animations.md:449` says it outright — "Define variants at **module scope** (not inline) to avoid object recreation on every render" — and the guide already publishes the canonical `collapseVariants` + `collapseTransition` shape at `:420-427`. Nothing exports it, so every author retypes it and picks a number. A user expanding a tool card and then a task row sees the same gesture at two speeds.

**Recommendation.** Export `COLLAPSE_VARIANTS` and `COLLAPSE_TRANSITION` (one duration — 200ms, `cubic-bezier(0, 0, 0.2, 1)`) from `layers/shared/lib`, alongside the `--msg-*` and `--identity-*` families that already do this properly, and replace all fifteen. Pairs with 5.4 so the CSS and JS collapses agree.

### 17.9 — No shared `Spinner` — `Loader2 + animate-spin` at 44 call sites with drifting size and missing `aria-hidden`

**P3 · M · lens 3**
Representative: `features/mesh/ui/DiscoveryView.tsx:295,307`, `chat/ui/tools/ToolCallCard.tsx:23,142`, `chat/ui/tasks/TaskActiveForm.tsx:20`, `composer/ui/InputActionButton.tsx:305`, `shared/ui/DirectoryPicker.tsx:259`, `features/tasks/ui/TaskRunHistoryPanel.tsx:68`, `agent-settings/ui/ManagedMcpServerCard.tsx:170`, `mesh/ui/TopologyGraph.tsx:270`, `features/tasks/ui/TasksView.tsx:39,78`

**Evidence.** `design-system.md`'s "Loading" section documents this as one convention ("Tool running: spinning icon (`Loader2` from lucide)") but there is no component embodying it; every call site imports `Loader2` directly and writes its own className. Sampling the 44 hits shows real drift, not just repetition. **Size:** `size-3`, `size-3.5`, `size-4`, `size-5`, `size-8`, and `h-5 w-5` (`TopologyGraph.tsx:270`, the old Tailwind v3 spelling) all appear for the same "inline loading" affordance. **Token syntax:** `size-(--size-icon-xs)` (`ToolCallCard.tsx:23`) vs `size-[--size-icon-xs]` (`ShapeForkForm.tsx:113`) — two Tailwind v4 arbitrary-value forms for one CSS property, so a repo-wide search for one misses the other. **Accessibility:** `aria-hidden` is present on some (`ToolCallCard.tsx:23`, `TaskActiveForm.tsx:20`) and absent on others doing the identical job (`ManagedMcpServerCard.tsx:170`, `ToolCallCard.tsx:142`) — a decorative spinner without it is read aloud with no label. **Colour:** most use `text-muted-foreground` correctly, but `TasksView.tsx:39,78` and `TaskRunHistoryPanel.tsx:68` use raw `text-blue-500` for the same "in progress" meaning (see 4.4).

**Recommendation.** Add a `Spinner` to `shared/ui` wrapping `Loader2` with a `size` prop mapping to the `--size-icon-*` tokens and `aria-hidden` baked in by default. Migrate call sites opportunistically — high file-count, low risk, better as a follow-up sweep than one PR.

### 17.10 — Two files bypass the shared `Skeleton` primitive with hand-rolled pulses

**P3 · S · lens 3**
`apps/client/src/layers/features/agents-list/ui/AgentGhostRows.tsx:19-32`, `features/marketplace/ui/MarketplaceSourcesView.tsx:192`

**Evidence.** `shared/ui/skeleton.tsx` exists and is well adopted (49 usages; `PackageLoadingSkeleton.tsx` composes it correctly). But `AgentGhostRows.tsx:22-30` hand-rolls its placeholder bars (`<div className="bg-muted h-3 w-32 rounded" />`) instead of `<Skeleton className="h-3 w-32" />`, and `MarketplaceSourcesView.tsx:192` writes `<div className="bg-muted h-20 animate-pulse rounded-xl border" />`. Both produce a visually similar but not identical pulse — `Skeleton` uses the app's `animate-tasks` keyframe and `bg-accent`; these use raw `animate-pulse` and `bg-muted` — so a `prefers-reduced-motion` or theme change to the app's pulse silently will not reach them.

**Recommendation.** Swap both to `<Skeleton>`. Only two occurrences, below the three-strike bar for extracting something new — but the primitive already exists, so this is a drop-in fix, not a design decision. Fold into whichever sweep touches these files.

### 17.11 — Three hand-rolled elapsed-time bucketings re-derive the same arithmetic

**P3 · S · lens 3**
`apps/client/src/layers/shared/lib/session-utils.ts:71-95` (`formatRelativeTime`), `shared/lib/format-compact-age.ts:34-42` (`formatCompactAge`), `features/profile/lib/profile-status.ts:27-57` (`durationWords`, `agoWords`)

**Evidence.** Partly already handled well: `format-compact-age.ts:1-14` explicitly cites `formatRelativeTime` and explains why its output must differ (compact "5m"/"2h" for a dense row vs the sentence form "45m ago"/"Yesterday, 3pm"), and `profile-status.ts:40-42` does the same. The _words_ genuinely need to differ three ways — that part is settled and not a finding. What is not justified is that all three re-derive the same minute/hour/day arithmetic from scratch: each defines its own `MINUTE_MS`/`HOUR_MS`/`DAY_MS` constants and its own `Math.floor(elapsed / X)` cascade, and `profile-status.ts` duplicates it _within the same file_ (`durationWords` at `:27-35` and `agoWords` at `:47-57` both re-derive the breakpoints independently).

**Recommendation.** Extract a low-level `bucketElapsedMs(ms): { value: number; unit: 'minute' | 'hour' | 'day' }` into `shared/lib/`, and have all four functions call it and own only their word choice on top. P3 because each is individually documented and elapsed-time math rarely changes, so the drift risk is bounded.

### 17.12 — Two near-identical removable filter chips

**P3 · S · lens 12**
`apps/client/src/layers/features/tasks/ui/TasksPanel.tsx:211-224` (`AgentFilterChip`), `apps/client/src/layers/shared/ui/filter-bar/FilterBarActiveFilters.tsx:134-142`

**Evidence.** Both render a `rounded-full border px-2 text-xs` pill with a label and a trailing `X` button styled `hover:text-foreground -mr-0.5 rounded-full p-0.5`. The shared implementation already exists in `shared/ui` — the feature simply could not reach for it, because the filter-bar's chip is coupled to `FilterBarContext` and `TasksPanel`'s agent filter is not wired to it. Only two instances today (below the three-strike bar, hence P3), but it is the same visual and interaction contract drawn twice for a structural reason, and dismissible filters are common enough that a third is likely.

**Recommendation.** Extract the presentational half — label plus dismiss button, no context dependency — as `<RemovableChip label onRemove>` in `shared/ui`, and have both `FilterBarActiveFilters` and `TasksPanel`'s `AgentFilterChip` render it.

---

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

---

## Batch 19 — FSD placement and naming

**Priority P2 · 7 findings · 5S · 2M**
**Scope:** layer hygiene. Five are one-line or one-file moves; the playground sweep and the rename are larger. `apps/client/eslint.config.js` blocks `features/ → widgets/` and enforces barrel-only inside `entities/`, but nothing stops one feature importing another feature's internals — 19.1 stands in that gap.

### 19.1 — A feature reaches past a sibling feature's barrel into its private model

**P2 · S · lens 4**
`apps/client/src/layers/features/settings/ui/ToolsTab.tsx:9`, `apps/client/src/layers/features/agent-settings/model/use-agent-context-config.ts:26`, `apps/client/src/layers/features/agent-settings/index.ts`

**Evidence.** Verified in source: `import { useAgentContextConfig } from '@/layers/features/agent-settings/model/use-agent-context-config';`. The `agent-settings` barrel does not export that hook at all — its docstring says its tabs are exported "for reuse in sibling feature UI" as _components_ (`IdentityTab`, `IntegrationsTab`, `ToolsTab`); the hook was never meant to leave the slice. `.claude/rules/fsd-layers.md:34` states the rule: "Model/hook cross-imports: FORBIDDEN. A feature's model/hooks must never import from another feature's model/hooks," with the worked example ending "WRONG — lift to entities or shared." `ToolsTab.tsx` is a UI file rather than a model file, but the substance is identical, and lint does not catch it.

**Recommendation.** `useAgentContextConfig` reads config both `agent-settings` and `settings` need — the textbook "lift it" case the rule's own example describes. Move it to `entities/agent` (or `entities/config`, whichever already owns the underlying config shape) so both features consume it through an entity barrel, sibling-safe by construction.

### 19.2 — A widget deep-imports a feature component its barrel already exports

**P2 · S · lens 4**
`apps/client/src/layers/widgets/tasks/ui/TasksPage.tsx:12`, `apps/client/src/layers/features/tasks/index.ts:14`

**Evidence.** Verified: `import { TasksList } from '@/layers/features/tasks/ui/TasksList';` while `features/tasks/index.ts:14` already has `export { TasksList } from './ui/TasksList';`. `widgets/ → features/` is an allowed direction, so this is hygiene rather than a layer violation — but it defeats the barrel's purpose (hiding the feature's internal file layout from consumers) for no reason, since the same symbol is one import away. `fsd-layers.md:103-111` gives "Always Import from index.ts" as a hard convention with a worked WRONG example of exactly this shape.

**Recommendation.** Change the one import to `from '@/layers/features/tasks'`. One line, no behaviour change.

### 19.3 — `ConnectionStatusBanner` lives in `shared/ui` with one consumer, reached through a pointless shim

**P2 · S · lens 4**
`apps/client/src/layers/shared/ui/ConnectionStatusBanner.tsx` (89 lines), `apps/client/src/layers/features/relay/ui/ConnectionStatusBanner.tsx`, `apps/client/src/layers/features/relay/index.ts:13`

**Evidence.** Verified: `features/relay/ui/ConnectionStatusBanner.tsx` is a single line — `export { ConnectionStatusBanner } from '@/layers/shared/ui';` — and `features/relay/index.ts:13` re-exports it a second time. A full scan of consumers outside the definition file found only `features/relay` (via those two shim layers) and the playground's `RelayShowcases.tsx`, which already imports from the relay barrel. The component's own docstring says it is specifically the relay panel's banner, distinct from the per-session connection UI elsewhere — it is feature-specific by its own description. Placing it in `shared/ui` forces `features/relay` to grow a one-line pass-through purely because the component is in the wrong layer.

**Recommendation.** Move `ConnectionStatusBanner.tsx` into `features/relay/ui/`, delete the pass-through file, and export it once from `features/relay/index.ts`. `shared/ui`'s barrel loses one export; no other consumer is affected. Do it in the same PR as 14.7, which rewrites the component to compose `Banner`.

### 19.4 — The Dev Playground routinely bypasses barrels that already export what it needs

**P2 · M · lens 4**
All under `apps/client/src/dev/showcases/`: `MiscShowcases.tsx:2` (`CelebrationOverlay`, barrel `features/chat/index.ts:23`), `ToolShowcases.tsx:4` and `StatusShowcases.tsx:12` (`ErrorMessageBlock`, `:33`), `StatusShowcases.tsx:14` (`TaskListPanel`, `:40`), `BackgroundTaskShowcases.tsx:2` (`BackgroundTaskBar`, `:41`), `ComposerShowcases.tsx:24` (`QueuePanel`, `:42`), `MessageShowcases.tsx:2-4` (`UserMessageContent`, `AssistantMessageContent`, `MessageProvider`, `:32-37`), `StatusShowcases.tsx:11` (`StreamingText`, `:36`)

**Evidence.** Nine symbols imported from deep `features/chat/ui/...` paths that `features/chat/index.ts` already exports at the barrel. `StreamingText` is the sharpest case: its own module doc at `features/chat/index.ts:27-30` explains it is exported specifically for a _second consumer_ — and the playground reaches past that intended entry point too. The same directory also deep-imports `features/relay`, `features/mesh`, `features/dashboard-sidebar`, `features/settings` and `features/room-management` internals (`AdapterWizardShowcases.tsx:7-11`, `topology-relay-flow-pulse.tsx:4-5`, `MobileTabsShowcases.tsx:26-28`, `SettingsShowcases.tsx:25-33`, `RoomsShowcases.tsx:35-36`); not all of those symbols are barrel-exported, so they were not individually verified as "available but bypassed", but the pattern is the directory's dominant import style. The playground is the part of the codebase most likely to be read by a new contributor learning the patterns — that is its stated purpose — and `maintaining-dev-playground/SKILL.md:181` models the convention correctly in its own worked example.

**Recommendation.** For the nine already-exported `features/chat` symbols, mechanical find-and-replace to `@/layers/features/chat`. For genuinely-internal symbols the playground needs (`ToolCallCard`, `SubagentBlock`, `ThinkingBlock`), the real decision is upstream: either add them to the barrel — the same logic `StreamingText`'s docstring already applies — or accept that the playground is a deliberate exception to barrel-only and say so once in the skill, rather than leaving it silently inconsistent file by file.

### 19.5 — `SettingsPanel` is a dead export

**P3 · S · lens 4**
`apps/client/src/layers/shared/ui/settings-panel.tsx:22`, re-exported at `shared/ui/index.ts:138-139`

**Evidence.** Verified: `grep -rn "SettingsPanel"` across the client returns only the barrel's two export lines and its own `__tests__/settings-panel.test.tsx`. (The unrelated `ManifestSettingsPanel` in `features/extensions` matches the substring but is a different component.) Its docstring says it is "for use inside a bare `NavigationLayout` (without `TabbedDialog`)", and there is no bare-`NavigationLayout` caller anywhere — the one consumer of `NavigationLayoutPanel` outside `shared/ui` is `features/settings/ui/tabs/PreferencesTab.tsx`, which is rendered _inside_ `TabbedDialog`, precisely the case the docstring says makes `SettingsPanel` unnecessary. Added 2026-07-29 (PR #606); never adopted. AGENTS.md §Quality Standard: "no dead code."

**Recommendation.** Delete the component, its props type and the two barrel lines. If a future settings surface needs the bare-`NavigationLayout` shorthand it is cheap to re-add with a real caller attached. **Note:** the raw organization report paired this with `NavigationLayoutSectionHeader`; that half was **verified false** — it is rendered at `shared/ui/tabbed-dialog.tsx:195` and must not be deleted.

### 19.6 — `features/commands` and `features/command-palette` are two different things with one name

**P3 · S · lens 4**
`apps/client/src/layers/features/commands/index.ts` and `ui/CommandPalette.tsx:12`; `apps/client/src/layers/features/command-palette/index.ts` and `ui/CommandPaletteDialog.tsx`

**Evidence.** Both slices describe themselves with the same two words. `features/commands` is "Commands feature — slash command palette with fuzzy search" and exports one component, `CommandPalette` — the dropdown that appears under the composer when a message starts with `/`. `features/command-palette` is "Command palette — global Cmd+K agent switching and feature access", ~40 files, exporting `CommandPaletteDialog`. The smaller slice's component is literally named `CommandPalette`, the name a reader reaches for first when looking for ⌘K, and `grep -rn CommandPalette` returns hits from both.

**Recommendation.** Rename the smaller slice to match what it draws — it is a slash-command dropdown, not a palette dialog. `features/commands` → `features/slash-commands`, and its `CommandPalette` → `SlashCommandList`. Low risk: the component has exactly two consumers (`widgets/session/ui/SessionComposer.tsx`, `dev/showcases/ComposerShowcases.tsx`).

### 19.7 — `CockpitLocation` puts a retired word on a public barrel

**P3 · M · lens 5**
`apps/client/src/layers/entities/session/index.ts:18`, `entities/session/lib/session-navigation-intent.ts:43,60,84,111`, `entities/session/lib/switch-agent-cwd.ts:4,29`; 615 case-insensitive occurrences of "cockpit" across `apps/client/src`

**Evidence.** `export type { CockpitLocation }` sits on the `entities/session` barrel. AGENTS.md §Vision retires "cockpit" from _user-facing prose_, and the guard (`scripts/check-banned-words.sh`) correctly ignores identifiers — so this is **not** a rule violation. But 615 occurrences in client source, including this exported identifier and comments like `touch-target.ts:12`'s "every surface in the phone cockpit", mean the retired word is still what the codebase teaches a new contributor, and a barrel export is the most visible place it survives. A contributor who reads `CockpitLocation` will use "cockpit" in the next comment, the next commit message, and eventually the next UI string, where it _is_ a violation.

**Recommendation.** Rename `CockpitLocation` → `AppLocation` (7 references, one commit) and sweep comments opportunistically — when a file is touched for another reason, replace "cockpit" with "the app" in its prose. Do **not** run a 615-site find-and-replace: it would touch nearly every file in the client, collide with every open worktree, and buy nothing an opportunistic sweep does not. Note the boundary in AGENTS.md §Vision in one clause so the next auditor knows identifiers were considered and deliberately handled this way.

---

## Batch 20 — Dev Playground: organization and coverage

**Priority P2 · 10 findings · 7S · 3M**
**Scope:** `apps/client/src/dev/` — 24 pages, 92 showcase files, 241 registry entries. **All findings here are source-read only**; the live browser pass over `/dev` could not run (see [Dropped](#dropped-and-narrowed)), so hover states, per-page console errors and the mobile spot-check remain unaudited.

### 20.1 — The Conversation page carries 54 sections in one flat, ungrouped list

**P2 · M · lens 6**
`apps/client/src/dev/sections/conversation-sections.ts` (53 entries, verified by count), `dev/playground-config.ts:200` (one cross-listed section, for 54), `dev/pages/ConversationPage.tsx:24-57`, `dev/TocSidebar.tsx:17-56`, `dev/PlaygroundSearch.tsx:17-25`, `dev/playground-registry.ts:36-48`

**Evidence.** `ConversationPage` renders 17 showcase components back to back with only a code comment between them — no visual sub-heading. Both places a person navigates from render it as one flat list: `TocSidebar` maps `sections` straight into a single `<ul>` of truncated links in a 176px sticky column (54 items, no grouping, no headers), and `PlaygroundSearch` groups ⌘K results only by page, so selecting "Conversation" surfaces one 54-item `CommandGroup`. A 176px column of 54 truncated single-line links is not a navigation aid — Priya scanning for one component reads past 40+ irrelevant titles. The SKILL's own new-page trigger ("5+ sections that don't fit naturally") is a page-level admission that this volume needs structure; Conversation is ten times that trigger with none. The data to group them already exists: every section carries a populated `category` (`Messages`, `Tools`, `Chips`, `Input`, `Status`, `Misc`), and `playground-registry.ts:40-43` documents that nothing reads it.

**Recommendation.** Two independent fixes, either worth doing alone. (1) Wire the existing `category` into `TocSidebar` as sub-headings — cheap, no anchor or URL changes, and it works for every oversized page at once (see 20.3). (2) Split the page along the boundary the showcase-file header comment already documents: keep `Conversation` for Messages/Tools/Chips (message rendering, the page's namesake) and give Status/Input/Composer their own page. Any split preserves existing anchors via the cross-listing mechanism (`playground-config.ts:88-129`), so no `/dev/conversation#…` link breaks.

### 20.2 — Components (47) and Subsystems (46) have the same overload

**P2 · M · lens 6**
`apps/client/src/dev/sections/components-sections.ts` (47, verified), `dev/sections/features-sections.ts:1-26`, `features-agent-sections.ts`, `features-surface-sections.ts`, `dev/pages/{FeaturesPage,ComponentsPage}.tsx`

**Evidence.** Three pages sit far above every other: Conversation 54, Components 47 (8 categories across 7 showcase files), Subsystems 46 (`FEATURE_AGENT_SECTIONS` 29 + `FEATURE_SURFACE_SECTIONS` 17). `features-sections.ts:13-19`'s own docstring explains the split happened **because the combined array passed the 500-line file-size cap** — but the split stopped at the data file: `FeaturesPage.tsx` still renders both halves as one continuous page with one flat TOC, so the maintainer-recognised "this is too much in one array" signal never became "this is too much on one page." The rest of the distribution — Rooms 17, Identity 18, Forms 15, Gen UI 14, Settings 13, Marketplace 12, Command Palette 10, Tokens 8, down to 1 — shows the playground is navigable up to roughly 15-20 sections; three pages sit at 2.5-3× that, with the same flat-TOC and flat-⌘K problem.

**Recommendation.** Propose a soft cap of **~20 sections per page** (where the natural distribution already breaks) and a split rule: **when a page's section file needs the 500-line split, split the page along the same seam.** Concretely: `Subsystems` → an "Agent & Relay" page and a "Home, Inbox & Approvals" page along the existing `FEATURE_AGENT_SECTIONS`/`FEATURE_SURFACE_SECTIONS` boundary; `Components` → carve `Chat Primitives` and `Sidebar` out to pages where they already have siblings (see 20.9).

### 20.3 — `category` is populated on all 241 registry entries and rendered nowhere

**P3 · S · lens 6**
`apps/client/src/dev/playground-registry.ts:36-48`, `dev/TocSidebar.tsx:17-56`, `dev/PlaygroundSection.tsx`

**Evidence.** `playground-registry.ts:36-44` documents, correctly and honestly, that `category` is "In-file documentation only… Nothing reads it." Confirmed: neither `PlaygroundSection.tsx` nor `PlaygroundPageLayout.tsx` references it. Not wrong on its own — but it is a missed structural opportunity given 20.1 and 20.2, because the exact metadata needed to sub-group those TOCs already exists on every entry and is already curated and clean (`Messages`, `Tools`, `Chips`, `Input`, `Status`, `Misc` for Conversation; `Layout`, `Buttons`, `Feedback`, `Navigation`, `Sidebar`, `Overlays`, `Data Display`, `Chat Primitives` for Components).

**Recommendation.** The cheapest fix available for the oversized-page problem: group `TocSidebar`'s `<ul>` by consecutive `category` runs (the arrays are already ordered by category, evident from every section file's inline showcase comments marking the boundaries) and render a small sub-heading per run. No data-model change, no anchor change, no new page.

### 20.4 — The composed panels the SKILL itself flags are still missing, and its example names are dead

**P2 · M · lens 6**
`.claude/skills/maintaining-dev-playground/SKILL.md:90-98`, `apps/client/src/layers/features/relay/ui/MessagingConnections.tsx`, `features/mesh/ui/TopologyPanel.tsx`, `features/mesh/ui/DiscoveryView.tsx`, `features/tasks/ui/TasksPanel.tsx`, `apps/client/src/dev/showcases/ConnectionsShowcases.tsx:1-5`

**Evidence.** The SKILL says by name: _"Today, showcases render only leaf components… Full widget panels like `RelayPanel`, `MeshPanel`, and `TasksPanel` are NOT showcased — only their children are."_ Checked against the current tree: **`RelayPanel` and `MeshPanel` no longer exist under those names** — the relay composed panel is now `MessagingConnections` (381 lines, exported, consumed at `widgets/connections/ui/MessagingRegion.tsx`), and mesh's are `TopologyPanel` (355 lines) and `DiscoveryView` (396 lines), both exported and consumed in production. `TasksPanel` still exists under that name (225 lines, consumed at `widgets/app-layout/model/wrappers/TaskDialogWrapper.tsx`) and is still not showcased. Verified by grep: none of `MessagingConnections`, `TopologyPanel`, `DiscoveryView` or `TasksPanel` appears anywhere under `apps/client/src/dev/`. Meanwhile the leaf showcases do exist — this is the "Parity Problem" the SKILL dedicates a whole section to: the composed experience is invisible, so a regression in how the pieces fit together (spacing, empty states, loading sequencing across the panel) has no showcase to catch it. And the doc's own examples have silently gone stale, which will send the next reader searching for files that do not exist.

**Recommendation.** (a) Update the SKILL's example names to `MessagingConnections`/`TopologyPanel`+`DiscoveryView` so it points at real files. (b) Add showcases for at least `TasksPanel` and `MessagingConnections` — both under 400 lines — using the props-injection pattern the SKILL prescribes at `:107-128` if either only reads from hooks.

### 20.5 — `PulsePanel`, present on every route, has zero playground presence

**P2 · S · lens 6**
`apps/client/src/layers/widgets/pulse/ui/PulsePanel.tsx:1-36`, `PulseAttentionSection.tsx`, `PulseActivitySection.tsx`

**Evidence.** Verified by grep: none of the three appears anywhere under `apps/client/src/dev/`. `PulsePanel`'s own docstring calls it _"the always-present global spine tab of the right inspector panel… the first tab on every route and the panel's no-selection fallback."_ By the SKILL's own candidacy criteria it clears every bar — visual and reusable (present on every route), a composed widget or panel (the doc's exact example category), and complex enough to regress (two sub-sections with capped-teaser logic and an all-clear fallback state).

**Recommendation.** Add a `PulsePanel` showcase to a fitting page (Subsystems, alongside the other panels once 20.4 lands) with its documented states: populated, and the calm one-line all-clear each section falls back to.

### 20.6 — Ten `shared/ui` primitives with real production usage have no showcase

**P2 · S · lens 6**
`BoundedNumberInput`, `LinkSafetyModal`, `MarkdownErrorBoundary`, `MarkdownLink`, `PathInput`, `PermissionModeScopeNote`, `ProvenanceChip`, `SegmentedControl`, `TruncatedOutput`, `UnverifiedCatalogNotice` — all under `apps/client/src/layers/shared/ui/`

**Evidence.** Cross-referencing every named export in the barrel against `dev/` (grep for the exact identifier), then confirming real non-test consumers in `layers/` to rule out dead exports, found these ten with zero playground coverage and confirmed production use — every one in two or more distinct sites, `SegmentedControl` in four (`GlobalTrustRow`, `EffortRow`, `ChipTray`, `ReachMeSection`) and `PermissionModeScopeNote` in five (`FullPowerDoor`, `TaskFormInner`, `AutonomyConfirmDialog`, `PermissionModeItem`, `BindingAdvancedSection`). That is squarely inside the SKILL's "visual and reusable — renders UI that appears in more than one place" bar.

**Recommendation.** Add showcases: `BoundedNumberInput`, `PathInput` and `SegmentedControl` to the Forms page; the rest to Components' `Data Display` or `Feedback` categories. Several of these are also targets of other batches — showcasing `SegmentedControl` before 18.10 gives that motion change a place to be reviewed, and `LinkSafetyModal` before 3.3 gives that rewrite one.

### 20.7 — Connections: the composed regions behind `/connections` are unshowcased; only their leaves are

**P2 · S · lens 6**
`apps/client/src/dev/showcases/ConnectionsShowcases.tsx:1-5`, `apps/client/src/layers/widgets/connections/ui/AccountsRegion.tsx` (106 lines), `MessagingRegion.tsx` (67 lines)

**Evidence.** `ConnectionsShowcases.tsx` imports and shows only `ServiceTile` and `AccountRow`. The widgets that actually assemble the route have zero references anywhere under `dev/`. Same Parity Problem as 20.4, on a different feature — a second independent instance of the identical gap.

**Recommendation.** Add `AccountsRegion` and `MessagingRegion` showcases alongside the existing file, following the props-injection pattern if either only reads from hooks. Worth doing in the same PR as 20.4 since the fix pattern is identical.

### 20.8 — `mock-samples.ts` is 1,187 lines and about fifteen unrelated concerns

**P3 · S · lens 6**
`apps/client/src/dev/mock-samples.ts` (1,187 lines, verified)

**Evidence.** `.claude/rules/conventions.md`'s File Size table calls 500+ lines "Must split", with named extraction patterns. This file mixes background-task fixtures (`BACKGROUND_TASK_PARTS`, `:30`), error fixtures (`ERROR_PARTS`, `:157`), task/message/question samples (`:200-472`), file/queue/command fixtures (`:436-701`), session diagnostics (`:701`), identity statuses and a full mock team roster (`:837-1178`), and message-author constants (`:1178+`) — at least eight unrelated domains. This is exactly the situation `features-sections.ts` already solved for playground _sections_; the same discipline has not reached the mock-data file the SKILL names as core playground infrastructure. A 1,187-line file makes it hard to check "is there already a fixture for X" before adding a new one, which is how duplicate fixtures start.

**Recommendation.** Split along the domain boundaries already visible in the `export const` list — `mock-samples/tasks.ts`, `mock-samples/identity.ts` (statuses + `MOCK_IDENTITIES` + `MOCK_TEAM_ROSTER`), `mock-samples/session-diagnostics.ts`, `mock-samples/tool-parts.ts` — re-exported from an `index.ts` barrel so no import site changes.

### 20.9 — Sidebar showcases are split across three pages in two nav groups with no cross-reference

**P3 · S · lens 6**
`apps/client/src/dev/sections/components-sections.ts:156-235` (6 sections, Design System group), `sidebar-model-sections.ts:1-133` (7 sections, App Shell group), `sidebar-boot-sections.ts:1-59` (2 sections, App Shell group), `dev/playground-config.ts:313-322,350-369`

**Evidence.** Sidebar UI shows up in three unconnected places: `ComponentsPage`'s `Sidebar` category (`SidebarRow`, `SessionRow`, `SessionsView`, `EmbedSessionList`, `SidebarFooterStrip`, `verb-ladder-and-signals`), `SidebarModelPage`'s journey/state model, and `SidebarBootPage`'s boot skeleton and motion. Each page's `category` field says `'Sidebar'`, but `category` is never rendered (20.3), so nothing in the app connects the three — someone who opens `/dev/components` and finds `SidebarRow` has no link to the other two. The split itself looks deliberate (`sidebar-boot-sections.ts:30-32` explains why motion lives there specifically), so this is not a request to merge them; the code's reasoning is sound and should stand. It is a discoverability gap, not a correctness one.

**Recommendation.** Lightest fix: add one line to each of the three pages' `PageConfig.description` cross-referencing the other two — the same courtesy the codebase already extends to cross-listed sections (`playground-config.ts:80`, "Say so on the borrowing page"). No registry or anchor changes.

### 20.10 — The SKILL's App Shell page table is missing three of the group's ten pages

**P3 · S · lens 6**
`.claude/skills/maintaining-dev-playground/SKILL.md:58-64`, `apps/client/src/dev/playground-config.ts:255-379`

**Evidence.** The SKILL lists the App Shell group as seven pages ("Tour Spotlight, Command Palette, Filter Bar, Onboarding, Error States, Feature Promos, Settings"). `playground-config.ts` currently has ten — those seven plus `Sidebar Model` (`:350-359`), `Sidebar Boot & Motion` (`:360-369`) and `One Bar` (`:370-379`). The doc anticipates its own drift ("check there rather than trusting this table", `:56`), so this is not a broken promise, but three missing entries for pages shipping 13 sections between them is enough to misplace a new App Shell showcase.

**Recommendation.** A one-line table update. Keep the "check `playground-config.ts`" caveat — it is honest and cheap insurance against the next drift.

---

## Appendix — coverage and honest gaps

What each lens actually covered, and what it did not, so the gaps are visible rather than implied.

**Read in full by multiple lenses:** `contributing/design-system.md` (all 1270 lines), `contributing/animations.md`, `.claude/rules/{fsd-layers,components,conventions}.md`, `.claude/skills/maintaining-dev-playground/SKILL.md`, `AGENTS.md`, `apps/client/src/index.css`, and `apps/client/eslint.config.js`. ADRs checked before flagging: 0097, 0224, 0230, 0255, 0310, `260726-193526`, `260804-021140`, `260819-210153`, `260819-234827..30`, `260822-083228`, `260822-083229`, `260728-022013`.

**Well covered.** `layers/shared/ui/` was read by four lenses independently (CVA read 78 of 96 files line by line; DX read 37 plus a scripted sweep of all ~90; motion grepped all 96 and read 30; DRY listed all ~90 and read the primitive families). `apps/client/src/index.css` was read exhaustively for tokens and for all 40 keyframes. Main-surface desktop (1440×900) and phone (390×844) were both driven live across ten routes each.

**Sampled, not exhaustive.** The 60 `features/` and 17 `widgets/` slices: the code lenses grepped the whole tree for their specific patterns (so a hit anywhere surfaces) and then read only a representative subset end to end — roughly 15 slices deeply for DRY, ~16 components for CVA, ~15 for componentization. Copy read Settings, onboarding, errors and `shared/ui` in full and sampled the rest by grep-then-read. Findings are pattern-seeded, so defects expressed with structurally different markup are under-represented; this is a sample, not an exhaustive AST diff.

**Known gaps, in priority order for a follow-up pass.**

1. **The Dev Playground was never seen in a browser.** All ten batch-20 findings are source-read. Hover states, per-page console errors, showcase-vs-real drift and the mobile spot-check across 24 pages remain unaudited. Re-run that beat once the dev server is healthy.
2. **Loading and skeleton states were never observed.** The local dev server answered fast enough that no skeleton frame was caught on any of five pages. A CPU/network-throttled pass (via CDP) is needed to verify them; 6.5 was found by reading source, not by watching it.
3. **Tablet width (768–1023px) got a five-page sample only,** and it produced two P1s (2.2, 2.3). It deserves a full pass — the docked-right-panel configuration is materially different from both phone and desktop and was clearly never tested.
4. **The live account had small data** — two team members, one channel, one agent — so a large roster, a busy multi-session queue, an active turn in progress, a long inbox and a populated topology were not observable. Several findings (18.5's uncapped stagger, 1.4's sparse grid) predict behaviour at scale from source rather than from a screenshot.
5. **Not audited at all:** Team's Table/Topology/Denied/Access views; eleven of the thirteen Settings tabs at the browser level; package-detail and room-detail sub-pages; `/marketplace/sources`; `/feedback-requests` beyond its empty state; the Obsidian embed as its own surface; `gen-ui` motion (deliberately out of bounds — it has its own spec'd vocabulary); `apps/site`, `apps/desktop`, `apps/obsidian-plugin` (out of charter scope).
6. **Icon-sizing adoption** was counted for the documented token (2 files, verified) but the ~700 raw `size-N` occurrences were not individually traced to separate icons from status dots, avatars and spacing — so 4.3's defect rate is a lower bound on the _convention_ gap, not a precise count of mis-sized icons.
