[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 20 — Dev Playground: organization and coverage

**Priority P2 · 10 findings · 7S · 3M**
**Scope:** `apps/client/src/dev/` — 24 pages, 92 showcase files, 241 registry entries. **All findings here are source-read only**; the live browser pass over `/dev` could not run (see [Dropped](../01-findings.md#dropped-and-narrowed)), so hover states, per-page console errors and the mobile spot-check remain unaudited.

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
