# Lens 6 — Playground Organization & Coverage

Auditor scope: `apps/client/src/dev/` (24 pages, 92 showcase files, registry in
`playground-pages.ts` / `playground-registry.ts`), cross-referenced against
`apps/client/src/layers/shared/ui/` (~95 primitives) and a sample of
`layers/features/**` and `layers/widgets/**` composed panels.

## Coverage

**Examined in full:**

- Every file under `apps/client/src/dev/sections/` (23 files) — counted sections, categories, and lines per page.
- `playground-config.ts`, `playground-registry.ts`, `playground-pages.ts`, `TocSidebar.tsx`, `PlaygroundSearch.tsx`, `PlaygroundPageLayout.tsx` — the mechanics that render pages, TOC, and Cmd+K search.
- `.claude/skills/maintaining-dev-playground/SKILL.md` in full, cross-checked against the current registry.
- The full `shared/ui` barrel (`layers/shared/ui/index.ts`, ~269 named exports) — every top-level primitive name grep'd against `dev/` for a showcase reference, then grep'd against `layers/` for real production usage (to rule out dead exports masquerading as coverage gaps).
- `dev/__tests__/showcase-no-replicas.test.ts` and `dev/__tests__/every-showcase-mounts.test.tsx` in full — the playground's own anti-drift guardrails.
- Ran `playground-registry.test.ts` and `showcase-no-replicas.test.ts` live (32/32 green) — no currently-broken drift gate.
- Spot-checked 4 shared/ui primitives with multi-variant CVA (Button, Badge, Banner) against their showcases line-by-line for variant/size parity — all matched, no drift found there.

**Sampled, not exhaustive:**

- `layers/widgets/**` (18 widget slices) — checked each slice's barrel `index.ts` export list and grep'd the composed top-level components against `dev/`; did not read every widget's internal implementation.
- `layers/features/**` (60 features) — not enumerated exhaustively; followed leads from showcase imports and widget composition (Relay, Mesh, Tasks, Connections, Pulse) rather than a full feature-by-feature diff.
- Did not attempt full prop-by-prop diffing for all 92 showcase files against their real components — spot-checked several (Button, Badge, Banner, Trust Dial, Topology) via source reading; the two files with automated parity assertions (`showcase-no-replicas.test.ts`) cover 4 of the 92 explicitly.

**Skipped:**

- Visual/rendered inspection (no browser session) — all findings are from source and section-count evidence, not screenshots.
- `apps/client/src/dev/simulator/**` (scenario scripts) — out of scope for organization/coverage, it's playback logic not showcases.

---

### [P2/M] The Conversation page carries 54 sections in one flat, ungrouped list

**Current state:** `dev/sections/conversation-sections.ts` defines `CONVERSATION_SECTIONS` with 53 entries (lines 10-762), spanning eight source showcase files (`SurfacesShowcases`, `MessageShowcases`, `TimelineShowcases`, `ToolShowcases`, `AsksShowcases`, `ComposerShowcases`, `StatusShowcases`, `MiscShowcases` — file's own header comment, lines 3-9). `dev/playground-config.ts:200` appends one more cross-listed section (`approvalcard`), for **54 total**. `ConversationPage.tsx` (lines 24-57) renders 17 showcase components back-to-back with only a code comment separating them — no visual sub-heading.

Both places a person navigates from render this as one flat list:

- `TocSidebar.tsx:28-52` maps `sections` straight into a single `<ul>` of truncated links in a `w-44` (176px) sticky column — 54 items, no grouping, no headers.
- `PlaygroundSearch.tsx:63-79` groups Cmd+K results only by **page** (`groupByPage`, lines 18-25), so selecting "Conversation" in the palette surfaces one 54-item `CommandGroup`.

The data to group them already exists: every section carries a populated `category` field (`Messages`, `Tools`, `Chips`, `Input`, `Status`, `Misc` — visible throughout `conversation-sections.ts`), but `playground-registry.ts:40-43` documents that "nothing reads it" — confirmed: neither `TocSidebar.tsx` nor `PlaygroundSection.tsx` references `category` at all.

**Why it falls short:** a 176px-wide column of 54 truncated single-line links is not a usable navigation aid — Priya scanning for one component has to read past 40+ irrelevant truncated titles. The SKILL.md's own new-page trigger ("5+ sections that don't fit naturally") is a page-level admission that this volume needs structure; Conversation is 10x that trigger and has none.

**Recommendation:** two independent fixes, either is worth doing on its own:

1. Wire the existing `category` field into `TocSidebar` as sub-headings (cheap, no anchor/URL changes, works for every oversized page at once — see findings below).
2. Split the page along the boundary the showcase-file header comment already documents: e.g. keep `Conversation` for Messages/Tools/Chips (message rendering — the page's namesake), and give Status/Input/Composer their own page (or fold Status into the existing `entry-actions`-adjacent App Shell grouping). Any split preserves existing anchors per the SKILL's cross-listing mechanism (`IDENTITY_CROSS_LISTED` pattern, `playground-config.ts:88-129`), so no `/dev/conversation#...` link needs to break.

**Files:** `apps/client/src/dev/sections/conversation-sections.ts`, `apps/client/src/dev/pages/ConversationPage.tsx:24-57`, `apps/client/src/dev/TocSidebar.tsx:17-56`, `apps/client/src/dev/PlaygroundSearch.tsx:17-25`, `apps/client/src/dev/playground-registry.ts:36-48`

---

### [P2/M] Components and Subsystems pages have the same overload, at nearly the same size

**Current state:** two more pages sit far above every other page in the registry:

- `dev/sections/components-sections.ts` — 47 sections across 8 categories (`Layout`, `Buttons`, `Feedback`, `Navigation`, `Sidebar`, `Overlays`, `Data Display`, `Chat Primitives` — visible at lines 15, 35, 81, 145, 160, 241, 308, 441), sourced from 7 showcase files per the file's own header (lines 6-7).
- `dev/sections/features-sections.ts` (`Subsystems` page) — imports and concatenates `FEATURE_AGENT_SECTIONS` (29 sections) and `FEATURE_SURFACE_SECTIONS` (17 sections) for 46 total. The file's own docstring (lines 13-19) explains the split happened **because the combined array passed the 500-line file-size cap** — but the split stopped at the data file. `FeaturesPage.tsx` still renders both halves as one continuous page with one flat TOC, so the maintainer-recognized "this is too much in one array" signal never became "this is too much on one page."

Full per-page section counts (owned + cross-listed), for context on how much of an outlier these three are:

| Page                  | Sections | Page                       | Sections |
| --------------------- | -------- | -------------------------- | -------- |
| Conversation          | 54       | Command Palette            | 10       |
| Components            | 47       | Tokens                     | 8        |
| Subsystems (Features) | 46       | Tables                     | 8        |
| Rooms                 | 17       | Sidebar Model              | 7        |
| Forms                 | 15       | Entry Actions              | 7        |
| Gen UI (Widgets)      | 14       | Promos                     | 6        |
| Identity              | 18       | Topology                   | 6        |
| Settings              | 13       | Onboarding                 | 6        |
| Marketplace           | 12       | One Bar                    | 4        |
|                       |          | Error States               | 4        |
|                       |          | Filter Bar                 | 3        |
|                       |          | Sidebar Boot & Motion      | 2        |
|                       |          | Tour Spotlight / Simulator | 1 each   |

**Why it falls short:** the same flat-TOC / flat-Cmd+K problem as Conversation applies verbatim (`TocSidebar`/`PlaygroundSearch` have no per-page special case). The middle of the distribution (Rooms at 17, down to Tokens at 8) shows the playground is comfortable and navigable up to roughly 15-20 sections; three pages sit at 2.5-3x that.

**Recommendation:** propose a soft cap of **~20 sections per page** (matching where the natural distribution already breaks) and a split rule: **when a page's section file needs the 500-line file-size split (`conventions.md`'s existing rule), split the page along the same seam**, not just the data array. Concretely: `Subsystems` → split into an "Agent & Relay" page and a "Home, Inbox & Approvals" page along the exact `FEATURE_AGENT_SECTIONS` / `FEATURE_SURFACE_SECTIONS` boundary that already exists; `Components` → carve `Chat Primitives` and `Sidebar` (6 + 5 sections) out to pages where they already have siblings (see next finding).

**Files:** `apps/client/src/dev/sections/components-sections.ts`, `apps/client/src/dev/sections/features-sections.ts:1-26`, `apps/client/src/dev/sections/features-agent-sections.ts`, `apps/client/src/dev/sections/features-surface-sections.ts`, `apps/client/src/dev/pages/FeaturesPage.tsx`, `apps/client/src/dev/pages/ComponentsPage.tsx`

---

### [P3/S] Sidebar-related showcases are split across 3 pages in 2 different nav groups with no cross-reference

**Current state:** sidebar UI shows up in three unconnected places:

- `ComponentsPage` (Design System group) — a `Sidebar` category with 6 sections: `SidebarRow`, `SessionRow`, `SessionsView`, `EmbedSessionList`, `SidebarFooterStrip`, and `verb-ladder-and-signals` (`components-sections.ts:156-235`).
- `SidebarModelPage` (App Shell group) — 7 sections, all `category: 'Sidebar'`, covering the journey/state model (`sidebar-model-sections.ts:1-133`).
- `SidebarBootPage` (App Shell group) — 2 sections, also `category: 'Sidebar'`, covering boot skeleton and motion (`sidebar-boot-sections.ts:1-59`).

Each page's `category` field says `'Sidebar'`, but `category` is never rendered (see main Conversation finding), so there is no in-app signal connecting the three — a person who opens `/dev/components` and finds `SidebarRow` has no link to `/dev/sidebar-model` or `/dev/sidebar-boot`, and vice versa. The split does look deliberate (the boot page's own comment at `sidebar-boot-sections.ts:30-32` explains why motion lives there specifically), so this isn't a request to merge them — the code's own reasoning is sound and should stand.

**Why it falls short:** discoverability, not correctness. Three separate playground pages answering "what does the sidebar look like" is a legitimate information architecture the person browsing has no way to discover without already knowing all three page names.

**Recommendation:** the lightest fix: add one line to each of the three pages' descriptions (`PageConfig.description` in `playground-config.ts`) cross-referencing the other two, the same courtesy the codebase already extends to cross-listed sections elsewhere (`playground-config.ts:80`, "Say so on the borrowing page"). No registry/anchor changes needed.

**Files:** `apps/client/src/dev/sections/components-sections.ts:156-235`, `apps/client/src/dev/sections/sidebar-model-sections.ts`, `apps/client/src/dev/sections/sidebar-boot-sections.ts`, `apps/client/src/dev/playground-config.ts:313-322,350-369`

---

### [P2/M] Three widget-level composed panels the SKILL.md itself flags as missing are still missing — and the doc's example names are dead

**Current state:** `maintaining-dev-playground/SKILL.md` lines 90-98 say, by name: _"Today, showcases render only leaf components... Full widget panels like `RelayPanel`, `MeshPanel`, and `TasksPanel` are NOT showcased — only their children are."_

Verified against the current codebase:

- **`RelayPanel` and `MeshPanel` no longer exist under those names.** The Relay feature's composed panel is now `MessagingConnections` (`layers/features/relay/ui/MessagingConnections.tsx`, 381 lines, exported at `layers/features/relay/index.ts:8`, consumed in production at `layers/widgets/connections/ui/MessagingRegion.tsx`). The Mesh feature's composed panels are `TopologyPanel` (`layers/features/mesh/ui/TopologyPanel.tsx`, 355 lines) and `DiscoveryView` (`layers/features/mesh/ui/DiscoveryView.tsx`, 396 lines), both exported from `layers/features/mesh/index.ts` and consumed in production (`AccessView.tsx` for `TopologyPanel`).
- **`TasksPanel` still exists under that name** (`layers/features/tasks/ui/TasksPanel.tsx`, 225 lines, exported `layers/features/tasks/index.ts:6`, consumed in production at `layers/widgets/app-layout/model/wrappers/TaskDialogWrapper.tsx`) and, per a fresh grep of `dev/`, is **still not showcased** — the doc's claim is still true for this one.
- None of `MessagingConnections`, `TopologyPanel`, `DiscoveryView`, or `TasksPanel` appear anywhere under `apps/client/src/dev/` (confirmed by grep, zero hits for all four names).

Meanwhile `dev/showcases/ConnectionsShowcases.tsx:1-5` and `dev/showcases/RelayShowcases.tsx` / `dev/showcases/MeshShowcases.tsx` / `dev/showcases/TasksShowcases.tsx` do exist — they showcase the **leaf** pieces (`ServiceTile`, `AccountRow`, individual cards) exactly as the doc describes, but never the panel that composes them into what a user actually opens.

**Why it falls short:** this is the exact "Parity Problem" the SKILL.md dedicates a whole section to (lines 86-150) — the composed experience is invisible in the playground, so a regression in how the pieces fit together (spacing, empty states, loading sequencing across the whole panel) has no showcase to catch it. And the doc's own worked examples have silently gone stale, which will send the next person who reads it searching for files that don't exist.

**Recommendation:** (a) update SKILL.md's example names from `RelayPanel`/`MeshPanel` to `MessagingConnections`/`TopologyPanel`+`DiscoveryView` so the doc points at real files; (b) add showcases for at least `TasksPanel` and `MessagingConnections` (both under 400 lines, both already accept no problematic hook-only data per a quick read — worth confirming with the props-injection pattern the SKILL describes at lines 107-128 before showcasing).

**Files:** `.claude/skills/maintaining-dev-playground/SKILL.md:90-98`, `apps/client/src/layers/features/relay/ui/MessagingConnections.tsx`, `apps/client/src/layers/features/mesh/ui/TopologyPanel.tsx`, `apps/client/src/layers/features/mesh/ui/DiscoveryView.tsx`, `apps/client/src/layers/features/tasks/ui/TasksPanel.tsx`, `apps/client/src/dev/showcases/ConnectionsShowcases.tsx:1-5`

---

### [P2/S] PulsePanel — an "always present on every route" widget — has zero playground presence

**Current state:** `layers/widgets/pulse/ui/PulsePanel.tsx` is, per its own docstring (lines 5-8), _"the always-present global spine tab of the right inspector panel... the first tab on every route and the panel's no-selection fallback."_ It composes `PulseAttentionSection` (105 lines) and `PulseActivitySection` (63 lines). None of `PulsePanel`, `PulseAttentionSection`, or `PulseActivitySection` appear anywhere in `apps/client/src/dev/` (confirmed by grep — zero hits for all three).

**Why it falls short:** by the SKILL's own candidacy criteria, this clears every bar — "visual and reusable" (present on every route), "a composed widget or panel" (the doc's exact RelayPanel/MeshPanel example category), and "complex enough to regress" (two sub-sections with capped-teaser logic and an all-clear fallback state per the docstring at lines 16-18).

**Recommendation:** add a `PulsePanel` showcase to a fitting page (Subsystems/Features, alongside the other Relay/Mesh/Tasks panels once those land per the finding above) with its documented states: populated, and the "calm one-line all-clear" empty state each section falls back to (docstring line 17).

**Files:** `apps/client/src/layers/widgets/pulse/ui/PulsePanel.tsx:1-36`, `apps/client/src/layers/widgets/pulse/ui/PulseAttentionSection.tsx`, `apps/client/src/layers/widgets/pulse/ui/PulseActivitySection.tsx`

---

### [P2/S] 10 shared/ui primitives with real production usage have no playground showcase

**Current state:** cross-referencing every named export in `layers/shared/ui/index.ts` against `apps/client/src/dev/` (grep for the exact identifier), then confirming each has real non-test consumers in `layers/` (to rule out dead exports), found 10 primitives with zero playground coverage and confirmed production use:

| Component                 | Real usage (non-test, outside its own `ui/` file)                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BoundedNumberInput`      | `features/settings/ui/tabs/RoomsTab.tsx`, `widgets/control-center/ui/ControlCenterSwitches.tsx`, `features/room-management/ui/RoomLimitRow.tsx`                                                                                       |
| `LinkSafetyModal`         | `features/gen-ui/model/widget-context.tsx`, `features/mcp-apps/ui/McpAppFrame.tsx`, `features/mcp-apps/model/bridge.ts`                                                                                                               |
| `MarkdownErrorBoundary`   | `features/chat/ui/message/StreamingText.tsx`                                                                                                                                                                                          |
| `MarkdownLink`            | `features/chat/ui/message/StreamingText.tsx`, `widgets/room-view/ui/render-room-body.tsx`                                                                                                                                             |
| `PathInput`               | `features/settings/ui/runtimes/sections/ClaudeAccountsSection.tsx`, `features/agent-creation/ui/NamingStep.tsx`                                                                                                                       |
| `PermissionModeScopeNote` | `features/full-power-door/ui/FullPowerDoor.tsx`, `features/tasks/ui/TaskFormInner.tsx`, `features/status/ui/AutonomyConfirmDialog.tsx`, `features/status/ui/PermissionModeItem.tsx`, `entities/binding/ui/BindingAdvancedSection.tsx` |
| `ProvenanceChip`          | `entities/agent/ui/AgentExecutionRows.tsx`                                                                                                                                                                                            |
| `SegmentedControl`        | `features/settings/ui/runtimes/GlobalTrustRow.tsx`, `features/settings/ui/runtimes/rows/EffortRow.tsx`, `features/chat/ui/chips/ChipTray.tsx`, `features/notifications/ui/ReachMeSection.tsx`                                         |
| `TruncatedOutput`         | `features/chat/ui/tools/ToolCallCard.tsx`, `features/ask/ui/AskReceiptRow.tsx`, `features/ask/ui/QuestionAnswerSummary.tsx`                                                                                                           |
| `UnverifiedCatalogNotice` | `features/settings/ui/runtimes/rows/ModelRow.tsx`, `features/status/ui/ModelSelectionList.tsx`, `entities/agent/ui/AgentExecutionRows.tsx`                                                                                            |

Every one of these is used in 2+ distinct production sites (`SegmentedControl` in 4, `PermissionModeScopeNote` in 5), which is squarely inside the SKILL's "visual and reusable — renders UI that appears in more than one place" candidacy bar.

Separately: `SettingsPanel` (`shared/ui/settings-panel.tsx`) is exported from the barrel and covered by its own unit test, but has **zero** consumers anywhere outside its own file and its test (`grep -rl SettingsPanel apps/client/src` returns only `index.ts` and `__tests__/settings-panel.test.tsx`) — this reads as dead code rather than a playground gap, and is noted here for the DRY/dead-code lens rather than claimed as a coverage finding.

**Recommendation:** add showcases for the 10 confirmed-live primitives to the Components or Forms page as appropriate (`BoundedNumberInput`, `PathInput`, `SegmentedControl` → Forms; the rest → Components' `Data Display` or `Feedback` categories).

**Files:** `apps/client/src/layers/shared/ui/index.ts` (barrel), and the 10 primitive files under `apps/client/src/layers/shared/ui/`

---

### [P2/S] Connections widgets: the composed regions behind `/connections` are unshowcased; only their leaf children are

**Current state:** `dev/showcases/ConnectionsShowcases.tsx:1-5` imports and shows only `ServiceTile` and `AccountRow` from `layers/features/connections`. The widgets that actually assemble the `/connections` route — `layers/widgets/connections/ui/AccountsRegion.tsx` (106 lines) and `layers/widgets/connections/ui/MessagingRegion.tsx` (67 lines) — have zero references anywhere in `apps/client/src/dev/`.

**Why it falls short:** same Parity Problem as the RelayPanel/MeshPanel/TasksPanel finding above — this is a second, independent instance of the identical gap (leaf shown, composition invisible), on a different feature. Worth fixing together since the fix pattern is identical.

**Recommendation:** add `AccountsRegion` and `MessagingRegion` showcases alongside the existing `ConnectionsShowcases.tsx`, following the props-injection pattern the SKILL.md prescribes (section "Support data injection via props", lines 107-128) if either component currently only reads from hooks.

**Files:** `apps/client/src/dev/showcases/ConnectionsShowcases.tsx:1-5`, `apps/client/src/layers/widgets/connections/ui/AccountsRegion.tsx`, `apps/client/src/layers/widgets/connections/ui/MessagingRegion.tsx`

---

### [P3/S] `mock-samples.ts` is 1,187 lines — more than double the repo's own file-size cap, and a grab-bag of ~15 unrelated concerns

**Current state:** `apps/client/src/dev/mock-samples.ts` is 1,187 lines. `.claude/rules/conventions.md`'s File Size table calls 500+ lines "Must split," with named extraction patterns (sub-components, pure functions to a `lib/` file, types to a types file). This file mixes background-task fixtures (`BACKGROUND_TASK_PARTS`, line 30), error fixtures (`ERROR_PARTS`, line 157), task/message/question samples (lines 200-472), file/queue/command fixtures (lines 436-701), session diagnostics (line 701), identity statuses and a full mock team roster (lines 837-1178), and message-author constants (lines 1178+) — at least 8 unrelated domains in one file.

**Why it falls short:** this is exactly the situation `features-sections.ts` already solved for playground _sections_ (splitting at the 500-line cap, `features-sections.ts:13-19`) — the same discipline hasn't reached the mock-data file the SKILL.md names as core playground infrastructure ("Files to Know" table, SKILL.md line 260-261). A 1,187-line single file makes it hard to find "is there already a fixture for X" before adding a new one, which is exactly the kind of duplication the DRY 3-strike rule (`conventions.md`) exists to prevent.

**Recommendation:** split along the domain boundaries already visible in the `export const` list — e.g. `mock-samples/tasks.ts`, `mock-samples/identity.ts` (statuses + `MOCK_IDENTITIES` + `MOCK_TEAM_ROSTER`), `mock-samples/session-diagnostics.ts`, `mock-samples/tool-parts.ts` (background task + error parts) — re-exported from an `index.ts` barrel so no import site changes.

**Files:** `apps/client/src/dev/mock-samples.ts` (1,187 lines)

---

### [P3/S] SKILL.md's App Shell page table is missing 3 of the group's 10 current pages

**Current state:** `maintaining-dev-playground/SKILL.md:58-64` lists the App Shell sidebar group as 7 pages: _"Tour Spotlight, Command Palette, Filter Bar, Onboarding, Error States, Feature Promos, Settings."_ Reading `playground-config.ts`, the `app-shell` group currently has 10 pages — the 7 listed plus `Sidebar Model` (`playground-config.ts:350-359`), `Sidebar Boot & Motion` (`playground-config.ts:360-369`), and `One Bar` (`playground-config.ts:370-379`).

The doc anticipates its own drift ("check there rather than trusting this table," line 56), so this isn't a broken promise — but three missing entries for pages that ship real, sizable content (13 sections combined) is enough that a reader skimming the table rather than the source will misplace a new App Shell showcase.

**Recommendation:** a one-line table update. Low effort, keep the "check playground-config.ts" caveat since it's honest and cheap insurance against the next drift.

**Files:** `.claude/skills/maintaining-dev-playground/SKILL.md:58-64`, `apps/client/src/dev/playground-config.ts:255-379`

---

### [P3/S] `category` is populated on all 241 registry entries but rendered nowhere

**Current state:** `playground-registry.ts:36-44` documents, correctly, that `category` is "In-file documentation only... Nothing reads it," and that this has "never been a search grouping however it was written up." Confirmed: `grep -rn category apps/client/src/dev/PlaygroundSection.tsx apps/client/src/dev/PlaygroundPageLayout.tsx` returns nothing.

**Why it falls short:** this isn't wrong on its own — the comment is honest about what the field does. But it's a missed structural opportunity given the two findings above (Conversation, Components, Subsystems all being flat 46-54 item lists): the exact metadata needed to sub-group those TOCs already exists on every entry and is already curated (categories read cleanly: `Messages`, `Tools`, `Chips`, `Input`, `Status`, `Misc` for Conversation; `Layout`, `Buttons`, `Feedback`, `Navigation`, `Sidebar`, `Overlays`, `Data Display`, `Chat Primitives` for Components).

**Recommendation:** this is the cheapest fix available for the "too many sections on one page" problem — group `TocSidebar`'s `<ul>` by consecutive `category` runs (the array is already ordered by category, evident from every `sections-*.ts` file's own inline `// XShowcases` comments marking category boundaries) and render a small sub-heading per run. No data model change, no anchor change, no new page needed.

**Files:** `apps/client/src/dev/playground-registry.ts:36-48`, `apps/client/src/dev/TocSidebar.tsx:17-56`, `apps/client/src/dev/PlaygroundSection.tsx`
