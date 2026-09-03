# Browser Audit — Responsiveness (Lens 8)

Live-browser audit of `http://localhost:6241` against the operator's real account/data, at phone (390×844) and a tablet sample (768×1024). Method: Playwright MCP navigation + accessibility-tree snapshots (with bounding boxes for suspected overflow) + full-page screenshots, cross-referenced against the client source. Look-don't-touch throughout — every interaction was navigation, a panel open/close, Escape, or a bottom-tab switch; nothing was sent, saved, deleted, or toggled.

All screenshots referenced below live in
`/private/tmp/claude-501/-Users-doriancollier-Keep-dork-os-dorkos/7e747ff4-181e-4e1e-b81d-0c31854b5004/scratchpad/audit-shots/`.

---

## Findings (ranked)

### 1. P1 · Effort S — Schedules empty state renders clipped behind the header on phone

**Lens:** 8 (Responsiveness) / overlaps 9 (UI states)
**Files:** `apps/client/src/layers/widgets/tasks/ui/TasksPage.tsx:105-116`, `apps/client/src/layers/features/tasks/ui/TasksEmptyState.tsx:19-36`

**Evidence:** `/tasks` at 390×844, cold load. Screenshot: `tasks-phone.png`. The heading "No schedules yet." visually renders with its top half cut off behind the sticky header ("New Schedule" button bleeds through it). A boxed accessibility snapshot confirms the root cause: the empty-state wrapper's computed box is `[x=0, y=-10, w=390, h=845]` — i.e. it starts 10px _above_ the top of the viewport, behind the 36px header (which occupies `y=0..36`). `TasksPage.tsx:110` wraps `TasksEmptyState` in a bare `motion.div className="flex h-full flex-col items-center justify-center"` with **no scroll container** — unlike the data branch three lines down, which correctly wraps `TasksList` in `<PageContainer width="full" scroll={false}>`. The empty state's real content (heading + subtext + 4 template cards + "New custom schedule" button, ≈770px tall) is taller than the available `h-full` region (≈752px). With `justify-content: center` and no scroll escape hatch, the browser centers the overflow by pushing the excess equally above _and_ below the box — so the top ~18px of content renders off-screen, permanently unreachable (nothing to scroll).

**Recommendation:** Wrap the empty-state branch in the same `PageContainer` (or at minimum `overflow-y-auto`) the data branch already uses, and drop `justify-center` in favor of `justify-start` with top padding — a "no schedules yet" screen should never need vertical centering once it has to hold a 4-card template gallery. This is the textbook CSS trap (flex-column `justify-center` clipping content taller than its box) and the fix is one class change plus matching the existing `PageContainer` pattern already used two branches away in the same file.

---

### 2. P1 · Effort S — Workspaces empty state: long path overflows its card, straight off the screen

**Lens:** 8 (Responsiveness) — charter's own confirmed live bug (§8, "Overflow containment")
**Files:** `apps/client/src/layers/widgets/workspaces/ui/WorkspacesPage.tsx:197-205`

**Evidence:** `/workspaces` at 390×844. Screenshot: `workspaces-phone.png`. The "No worktrees yet" card's body text ends in `~/Keep/dork-os/dorkos/apps/desktop/.temp/.dork/wo…`, running past the card's right edge and off the viewport — exactly the bug the charter cites as confirmed. Root cause at `WorkspacesPage.tsx:200-204`: the interpolated `${shortenHomePath(root)}` sits inline inside a plain `<p className="text-muted-foreground mt-1 text-sm">`, with no `break-all`, no truncation, and no `min-w-0` on any ancestor. A filesystem path has no spaces, so the browser has no wrap opportunity and the unbroken token escapes the card and the page's own horizontal bounds.

**Recommendation:** Per the charter's own guidance — use the shared `path-breadcrumb` / `truncated-output` primitive if it fits this inline-sentence context, or at minimum add `break-all` (or `break-words` if mid-word breaks read badly here) plus `min-w-0` on the card and its flex ancestors so the path wraps or truncates inside the card instead of escaping it.

---

### 3. P1 · Effort M — Marketplace card grid uses viewport breakpoints, not the column's actual width — collapses to ~78px cards under any docked panel

**Lens:** 8 (Responsiveness) — adaptive layout
**Files:** `apps/client/src/layers/features/marketplace/ui/PackageGrid.tsx:146`, `apps/client/src/layers/features/marketplace/ui/FeaturedRail.tsx:30,51`

**Evidence:** `/marketplace` at 768×1024 (tablet), sidebar open + right panel (Pulse) open — the ordinary state for anyone using the app with the inspector panel docked. Screenshot: `marketplace-tablet.png`. The middle content column measures 236px wide (verified via bounding boxes: `main` region for the routed page is `[288,44]` → `472` wide split by a resizable divider into two 236px halves). Both `PackageGrid` (`className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"`) and `FeaturedRail` (`grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3`) key their column count off Tailwind's **viewport**-width breakpoints (`sm:`≥640px, `md:`≥768px). At a 768px _viewport_, `md:grid-cols-3` fires — regardless of the fact that the actual rendering column is only 236px CSS-wide. The result: package cards render at ~78px wide, with names truncated mid-word ("Code Revie", "Secur", "Do…"), category badges cut to "AGEN", "PLUGI…", Install buttons overlapping each other ("→ Install →"), and a horizontal scrollbar appears under the card rows (visible at the bottom of the screenshot) because even 78px isn't enough to contain the card's own min-content. The same collapse reproduces on `/tasks`' template gallery (`tasks-tablet.png`) and on `/activity`'s stat line and list rows (`activity-tablet.png`, described in finding 4) — this is a systemic pattern, not a one-off.

**Recommendation:** This is the classic "viewport breakpoint used for a component whose real width is set by sibling panels" bug. Swap `sm:`/`md:`/`lg:` grid-cols on `PackageGrid` and `FeaturedRail` for CSS container queries (`@container`, Tailwind v4 supports `@sm:`/`@md:` container variants natively) scoped to the routed-page container, so column count tracks the actual available width instead of the window's. This one change would also self-heal the tablet/phone package-grid squeeze without any special-casing per breakpoint.

---

### 4. P1 · Effort M — At 768px (first non-phone width) with the right panel docked, the page-tab strip collapses to ~16px and the content column to 236px — both effectively unusable

**Lens:** 8 (Responsiveness) — adaptive layout / breakpoint gap
**Files:** `apps/client/src/layers/widgets/one-bar/ui/HomeSurfaceBar.tsx`, `apps/client/src/layers/shared/ui/bar-tab-strip.tsx:142-158`, `apps/client/src/layers/features/right-panel/ui/RightPanelContainer.tsx:59-67` (`isMobile` gate at 768px)

**Evidence:** `/` at 768×1024 with the sidebar and the right panel (Pulse) both open — screenshot `home-tablet.png`. A depth-limited bounding-box snapshot shows: sidebar 272px, then a 472px region split by a resizable divider into a 236px chat column and a 236px right panel. Within the chat column's header, the `Home sections` `<nav>` (Home / Activity / Schedules / Workspaces) measures **16px wide** — no tab label is visible at all, not even a partial one with the documented fade cue; it is functionally gone. The code's own tab strip (`bar-tab-strip.tsx:142-158`) is `flex-initial` with `overflow-x-auto` and no `min-width` floor, so under the combined pressure of the health dot, the 2-members chip, and the fixed cluster (search/inbox/panel-toggle, all `shrink-0`), it has nowhere to shrink _to_ except its own scroll container's minimum, which browsers will happily collapse toward zero. This is materially different from the intentional, documented mobile trade-off in the same file (DOR-1180: "four labels do not fit a phone... the strip scrolls sideways, and says so") — that trade-off assumes the strip keeps _some_ visible width and a fade cue; at 768px with both panels docked, it keeps neither. The same squeeze independently starves the content column: on `/activity` (screenshot `activity-tablet.png`) the one-line stat "Your agents started 1 session this week" wraps to 7 lines of 1-2 words each, and the list rows below need a **horizontal scrollbar** (visible at the row's bottom edge) just to reach the "Open →" button. On `/tasks` (screenshot `tasks-tablet.png`) the 2-column template gallery wraps titles like "weekly-dependency-audit" across 4 lines in a ~110px-wide card.

**Recommendation:** `useIsMobile()`'s 768px cutoff is being treated as "everything above this is desktop-roomy," but 768px with a docked sidebar _and_ a docked right panel leaves less usable width than a bare phone. Two independent, complementary fixes: (a) give `BarTabStrip` a sane `min-width` (or switch its overflow handling to guarantee at least the active tab stays legible) so it never collapses below "one readable tab + fade," and (b) treat 768–1023px as a real tablet tier where the right panel defaults to the overlay/Sheet presentation (already built and used on phone) instead of the docked three-pane split, rather than only flipping to overlay below 768px. This is exactly the "define how each component degrades as items are added" case the charter calls out — the docked right panel is the "item added" that this breakpoint was never tested against.

---

### 5. P2 · Effort S — Right-panel mobile Sheet is always full-height regardless of content, leaving 50-70% of the screen blank

**Lens:** 8 (Responsiveness) — adaptive layout, strategy (d)
**Files:** `apps/client/src/layers/features/right-panel/ui/RightPanelContainer.tsx:202-226`, `apps/client/src/layers/shared/ui/responsive-sheet.tsx:24-58`

**Evidence:** `/` and `/session` at 390×844, right panel open (Pulse tab and Files tab respectively — both real, persisted per-agent state, not test artifacts). Screenshots: `home-phone-panel-closed.png` (Pulse: content ends ~y=250, sheet fills to 844 — ~590px of dead space) and `session-panel-files-header.png` (Files tab: 6 folder rows end ~y=240, same ~600px empty). `ResponsiveSheetContent` (`responsive-sheet.tsx:24-34`) always sets `side="right"` and widens to `w-full` on mobile — a right-edge slide-over stretched to fill the screen, not a sheet sized to its content. For panels whose content is inherently short (Pulse's "Needs attention" + recent activity; a 6-item file tree at the repo root), this produces a mostly-empty full-screen overlay with no visual cue that there is nothing more below, and no swipe-to-dismiss affordance (mobile users must find and tap the small "Close panel" `X`).

**Recommendation:** This is the charter's adaptive-layout case (d), "swap in a mobile-specific variant." A right-edge full-screen overlay is a reasonable adaptation for panels with substantial content (Terminal, Canvas), but for short-content panels a bottom sheet sized to content (with a drag handle and swipe-to-dismiss, capped at some max-height with its own scroll) would both look intentional and give the user a native "this is a compact panel" signal instead of a blank void. If a single presentation must be kept for simplicity, at minimum cap the sheet's height to its content on mobile rather than always filling the viewport.

---

### 6. P2 · Effort S — Channels empty state tells mobile users to look in "the sidebar," which doesn't exist at that width

**Lens:** 8/7 boundary (copy that fails to adapt across the app's own breakpoints)
**Files:** `apps/client/src/layers/widgets/room-view/ui/ChannelsPage.tsx:49-59`, `apps/client/src/layers/widgets/mobile-tabs/ui/MobileTabsLayout.tsx:1-43`

**Evidence:** `/channels` with no `?id=` at 390×844 — screenshot `channels-phone.png`. Copy reads: _"Channels and direct messages live in the sidebar. Open one to read it, or make a new channel..."_ There is no sidebar anywhere on screen, no hamburger/menu trigger in the header, and the shadcn `Sidebar`/`SidebarTrigger` primitives are unused everywhere in the app (`grep` confirms zero call sites outside their own file and barrel). The actual mobile navigation model — confirmed by tapping the bottom "All" tab, screenshot `channels-library-panel.png` — is a well-built, well-documented "Library" panel (`MobileTabsLayout.tsx`'s own top comment: _"Mobile is a different app, not a squeezed desktop... no hamburger, no scrim"_) that raises over the current screen and lists Channels + Agents. The mobile nav redesign is genuinely good; the empty-state copy on `/channels` simply never got updated to describe it, so a first-time mobile user reads instructions that describe a UI element that was deliberately removed.

**Recommendation:** Make the copy breakpoint-aware (or platform-neutral): "Open one from All to read it" / "Pick a conversation from All below" on phone, keeping "lives in the sidebar" for desktop/tablet where a sidebar is actually visible. `useIsMobile()` is already imported throughout the codebase for exactly this kind of branch.

---

### 7. P2 · Effort S — Marketplace search placeholder clips on phone; the "/" shortcut hint it's making room for is meaningless on touch

**Lens:** 8 (Responsiveness) — adaptive strategy (c), hide what doesn't earn its space on mobile
**Files:** `apps/client/src/layers/features/marketplace/ui/MarketplaceToolbar.tsx:165-177`

**Evidence:** `/marketplace` at 390×844 — screenshot `marketplace-phone.png`. The placeholder "Search packages…" renders visibly clipped to "Search packag" with no ellipsis, because the input reserves `pl-9` (icon) + `pr-10` (the `<kbd>/</kbd>` shortcut badge, `MarketplaceToolbar.tsx:174-177`) inside a field that's already sharing a 390px row with a `w-32 shrink-0` sort `<Select>`. The `/` keyboard-focus shortcut is a desktop power-user convenience (there is no physical keyboard shortcut context on a touchscreen), yet it's rendered unconditionally and eats real width from the one thing every visitor to this page needs to read: the placeholder telling them what the field is for.

**Recommendation:** Hide the `<kbd>` shortcut hint below the `isMobile` breakpoint (strategy (c): "hide an element entirely on mobile when it doesn't earn its space" — it doesn't, there's no keyboard). That alone reclaims enough width for the full placeholder at 390px without touching the `Select`.

---

### 8. P3 · Effort S — Horizontally-scrolling filter/tab chips are 24px tall, under the 44px touch-target guidance, and require a precise tap inside a scrollable strip

**Lens:** 8 (Responsiveness) — touch targets
**Files:** `apps/client/src/layers/features/activity-feed-page/ui/ActivityFilterBar.tsx:32,59` (also present in the same `h-6` shape wherever this chip pattern repeats, e.g. Team's kind filter)

**Evidence:** `/activity` at 390×844 — the "All / Schedules / Relay / Agent / Config / System" filter row (`ActivityFilterBar.tsx`) renders each chip at `h-6` (24px) inside a horizontally-scrolling `overflow-x-auto` strip. 24px is well under the ~44px minimum touch-target guidance, and it's compounded by living inside a strip a thumb might scroll instead of tap. Note: `design-system.md` documents `xs` buttons at 24px as an accepted token, so this isn't a one-off mistake — but a _filter chip a phone user taps repeatedly_, inside a _scrollable_ row, is a harder case than a single desktop-density button, and is worth a deliberate exception rather than inheriting the general button scale.

**Recommendation:** Keep the compact visual chip (Calm Tech density is a real constraint), but grow the tap target independently of the visual chip — e.g. wrap in a `min-h-11` pressable area with the visible `h-6` pill centered inside it, the same "small visual, larger hit box" pattern already used for icon buttons elsewhere in the design system. Downgraded to P3 because the chip height matches an already-accepted design token and the row does scroll rather than clip.

---

## Not flagged (deliberate, documented trade-offs — charter rule 4)

- **`BarTabStrip` scrolling with edge fades on phone** (`bar-tab-strip.tsx`) and the **Activity filter chips' own scroll-with-fade** (`ActivityFilterBar.tsx:98-107`) are both explicitly designed, ADR-cited (260725-004456) and measured-in-Chromium trade-offs, with inline comments stating the sub-44px row height was "flagged at the spec's phone checkpoint, not silently absorbed." Relitigating the base pattern would violate charter rule 4. Finding 4 above is a _different_ claim — that at 768px+docked-panel width the same mechanism degrades past its own design assumptions into an unreadable sliver, which the original trade-off doesn't cover.
- **Right-panel tab strip at `text-[10px]`** (`RightPanelHeader.tsx:269`) — global, not a phone-specific regression; out of this lens's scope (would belong under lens 1, tokens).
- **"New Agent" collapsing to an icon-only `+`** on `/team` at 390px — this is the charter's adaptive strategy (a) done correctly; noted as a positive, not a finding.

---

## Coverage

**Phone (390×844)** — full page visited, screenshot + accessibility-tree (with bounding boxes where overflow was suspected) captured for each:

| Page           | Screenshot(s)                                                                    |
| -------------- | -------------------------------------------------------------------------------- |
| `/` (Home)     | `home-phone.png`, `home-phone-panel-closed.png`, `home-phone-feed.png`           |
| `/session`     | `session-phone.png`, `session-panel-files-header.png`, `session-empty-phone.png` |
| `/activity`    | `activity-phone.png`                                                             |
| `/team`        | `team-phone.png`                                                                 |
| `/tasks`       | `tasks-phone.png`                                                                |
| `/channels`    | `channels-phone.png`, `channels-library-panel.png`                               |
| `/workspaces`  | `workspaces-phone.png`                                                           |
| `/connections` | `connections-phone.png`                                                          |
| `/marketplace` | `marketplace-phone.png`                                                          |

**Tablet (768×1024)** — 5-page sample as instructed:

| Page           | Screenshot               |
| -------------- | ------------------------ |
| `/` (Home)     | `home-tablet.png`        |
| `/session`     | `session-tablet.png`     |
| `/activity`    | `activity-tablet.png`    |
| `/tasks`       | `tasks-tablet.png`       |
| `/marketplace` | `marketplace-tablet.png` |

**Skipped entirely:** `/marketplace/sources`, `/feedback-requests`, `/dev/*` (out of the charter's named "main surfaces" list for this lens), any settings/preferences dialogs, and package-detail / room-detail sub-pages beyond the list/empty states shown above. Desktop width (≥1024px) is out of this lens's brief by design — the parallel "desktop" browser lens presumably covers it. Within the pages visited, only the states reachable without mutating anything were seen: real persisted per-agent panel state (which tab was last open) was left as found rather than reset, so "Pulse" vs. "Files" being the open tab on different pages reflects actual account history, not test setup — noted inline above wherever it affects a finding's reproducibility.
