---
slug: mesh-panel-consolidation
number: 233
created: 2026-04-11
status: ideation
---

# Consolidate Mesh Panel into Agents Page

**Slug:** mesh-panel-consolidation
**Author:** Claude Code
**Date:** 2026-04-11
**Branch:** preflight/mesh-panel-consolidation

---

## 1) Intent & Assumptions

- **Task brief:** Eliminate the MeshPanel dialog by migrating its unique functionality (Denied tab, Access tab, Agent Health Detail side panel) to the dedicated `/agents` page. Redirect all dialog entry points to page navigation. Remove the dialog and its infrastructure.
- **Assumptions:**
  - The Agents page is the correct long-term home for all agent/mesh management
  - All MeshPanel entry points (command palette, status card, feature promo, URL deep-link) can redirect to `/agents` with appropriate view params
  - The view switcher in AgentsHeader can be extended from 2 views (list, topology) to 4 views (list, topology, denied, access)
  - Discovery stays as a header-button dialog (not a tab) — it's a transient action, not a persistent view
  - The MeshStatsHeader aggregate status bar is not migrated — the Agents page's filter bar and status column provide equivalent information
- **Out of scope:**
  - Redesigning the Agents page layout or existing List/Topology views
  - Changing underlying mesh data hooks or transport layer
  - Onboarding flow changes (AgentDiscoveryStep is separate)
  - Unifying the discovery system (separate spec: unify-discovery-system)

## 2) Pre-reading Log

- `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx` (227 lines): Main dialog component. Mode A (full-bleed DiscoveryView when 0 agents) / Mode B (4-tab interface: Topology, Discovery, Denied, Access). Contains inline `DeniedTab` sub-component (lines 20-61). Manages `selectedAgentId`, `selectedProjectPath`, `activeTab` state.
- `apps/client/src/layers/features/mesh/ui/TopologyPanel.tsx` (258 lines): The "Access" tab content. Namespace grouping + cross-project ACL rule management. Sub-components: `NamespaceGroup`, `AccessRuleRow`, `AddRuleForm`. Uses `useTopology()` + `useUpdateAccessRule()`.
- `apps/client/src/layers/features/mesh/ui/AgentHealthDetail.tsx` (153 lines): Right-side panel for selected topology node. Shows status, timestamps, runtime, capabilities, settings button. Uses `useMeshAgentHealth(agentId)`. Fixed `w-64` width.
- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx` (345 lines): React Flow force-graph with ELK layout. Agent nodes, adapter nodes, binding edges, cross-namespace edges. MiniMap + Controls. Props include `onSelectAgent`, `onOpenSettings`, `onGoToDiscovery`, `onOpenChat`.
- `apps/client/src/layers/features/mesh/ui/MeshStatsHeader.tsx` (38 lines): Compact aggregate status bar (total agents + per-status dots). Uses `useMeshStatus()`.
- `apps/client/src/layers/features/mesh/index.ts`: Barrel exports `MeshPanel`, `DiscoveryView`, `ScanRootInput`.
- `apps/client/src/layers/widgets/app-layout/model/wrappers/MeshDialogWrapper.tsx` (36 lines): Dialog chrome around MeshPanel. Uses `ResponsiveDialog`, 85vh max height, 2xl max width.
- `apps/client/src/layers/widgets/app-layout/model/dialog-contributions.ts`: Mesh dialog registered with `openStateKey: 'meshOpen'`, `urlParam: 'mesh'`, priority 5.
- `apps/client/src/layers/shared/model/app-store/app-store-panels.ts`: `meshOpen` boolean + `setMeshOpen` setter in app store.
- `apps/client/src/layers/shared/model/use-dialog-deep-link.ts` (lines 171-174): `useMeshDeepLink()` using `useSimpleDialogDeepLink('mesh')`.
- `apps/client/src/layers/shared/lib/ui-action-dispatcher.ts`: `meshOpen` in `DispatcherStore` interface + `setPanelOpen`/`togglePanel` helpers.
- `apps/client/src/layers/features/command-palette/model/use-palette-actions.ts`: Two actions call `openMesh()` — `handleFeatureAction('openMesh')` and `handleFeatureAction('discoverAgents')`.
- `apps/client/src/layers/features/command-palette/model/palette-contributions.ts`: Feature item `{ id: 'mesh', label: 'Mesh Network', action: 'openMesh' }`.
- `apps/client/src/layers/features/dashboard-status/ui/SystemStatusRow.tsx` (line 92): Status card clicks `meshDeepLink.open()`.
- `apps/client/src/layers/features/feature-promos/ui/dialogs/AgentChatDialog.tsx`: Promo triggers `useMeshDeepLink().open()`.
- `apps/client/src/layers/widgets/agents/ui/AgentsPage.tsx` (107 lines): Mode A (AgentGhostRows) / Mode B (List or Topology via `?view=` param). Uses `useTopology()` + `useSearch()` from TanStack Router.
- `apps/client/src/layers/features/agents-list/ui/AgentsList.tsx` (191 lines): Sortable/filterable DataTable. FilterBar with search, status, namespace, sort. Inline row actions.
- `apps/client/src/layers/features/agents-list/ui/AgentGhostRows.tsx` (84 lines): Mode A empty state. Ghost rows + "Import Your Projects" CTA opening DiscoveryView dialog.
- `apps/client/src/layers/features/top-nav/ui/AgentsHeader.tsx` (95 lines): Page header. "New Agent" button, "Search for Projects" button (discovery dialog), view switcher tabs (List | Topology). Uses `navigate({ to: '/agents', search: { view: mode } })`.
- `apps/client/src/layers/widgets/app-layout/ui/AppShell.tsx` (lines 97-104): Header slot for `/agents` reads `?view` param and passes `viewMode` to AgentsHeader.
- `research/20260225_mesh_panel_ux_overhaul.md`: Prior research on the 5 MeshPanel tabs — empty states, progressive disclosure hierarchy, UX debt per tab.
- `research/20260226_mesh_topology_elevation.md`: React Flow enhancements — MiniMap, fly-to, ghost nodes, deny edges, LOD zoom.
- `research/20260303_command_palette_agent_centric_ux.md`: How command palette handles agent-centric navigation and agent switching.

## 3) Codebase Map

**Primary components/modules:**

| File                                         | Role                              | Lines |
| -------------------------------------------- | --------------------------------- | ----- |
| `features/mesh/ui/MeshPanel.tsx`             | Dialog root + DeniedTab           | 227   |
| `features/mesh/ui/TopologyPanel.tsx`         | Access tab (namespace ACL editor) | 258   |
| `features/mesh/ui/AgentHealthDetail.tsx`     | Topology node detail panel        | 153   |
| `features/mesh/ui/TopologyGraph.tsx`         | React Flow graph                  | 345   |
| `features/mesh/ui/MeshStatsHeader.tsx`       | Aggregate stats bar               | 38    |
| `features/mesh/ui/DiscoveryView.tsx`         | Discovery scanner UI              | ~200  |
| `widgets/agents/ui/AgentsPage.tsx`           | Page root (list/topology)         | 107   |
| `features/agents-list/ui/AgentsList.tsx`     | Agent DataTable                   | 191   |
| `features/agents-list/ui/AgentGhostRows.tsx` | Mode A empty state                | 84    |
| `features/top-nav/ui/AgentsHeader.tsx`       | Page header + view switcher       | 95    |

**Dialog infrastructure (to be removed):**

| File                                                      | Role                          |
| --------------------------------------------------------- | ----------------------------- |
| `widgets/app-layout/model/wrappers/MeshDialogWrapper.tsx` | Dialog chrome                 |
| `widgets/app-layout/model/dialog-contributions.ts`        | Registry entry (mesh)         |
| `shared/model/app-store/app-store-panels.ts`              | `meshOpen` / `setMeshOpen`    |
| `shared/model/use-dialog-deep-link.ts`                    | `useMeshDeepLink()`           |
| `shared/lib/ui-action-dispatcher.ts`                      | `meshOpen` in DispatcherStore |

**Entry points that trigger MeshPanel (to be redirected):**

| Trigger                           | File                                                     | Mechanism             |
| --------------------------------- | -------------------------------------------------------- | --------------------- |
| Command palette "Mesh Network"    | `features/command-palette/model/use-palette-actions.ts`  | `openMesh()`          |
| Command palette "Discover Agents" | Same file                                                | `openMesh()`          |
| Dashboard status card             | `features/dashboard-status/ui/SystemStatusRow.tsx`       | `meshDeepLink.open()` |
| Feature promo                     | `features/feature-promos/ui/dialogs/AgentChatDialog.tsx` | `meshDeepLink.open()` |
| URL deep-link `?mesh=open`        | `widgets/app-layout/ui/DialogHost.tsx`                   | `useMeshDeepLink()`   |

**Shared hooks (remain unchanged):**

- `useTopology()` — namespaces + access rules (used by both surfaces already)
- `useRegisteredAgents()` — agent list + loading/error
- `useDeniedAgents()` — denied paths list
- `useMeshAgentHealth(agentId)` — single agent health detail
- `useUpdateAccessRule()` — mutation for add/remove rules
- `useMeshScanRoots()` — discovery scan roots
- `useMeshStatus()` — aggregate status counts

**Data flow:**
`useTopology()` → AgentsPage flattens `namespaces.flatMap(ns => ns.agents)` → passes to view components. Each view adds its own specialized hooks (e.g., DeniedView uses `useDeniedAgents()`, AccessView uses `useUpdateAccessRule()`).

**Potential blast radius:**

- Direct changes: ~15 files (page, header, views, entry points, store, router)
- Deletions: ~5 files (MeshPanel, MeshDialogWrapper, MeshStatsHeader, dialog registration)
- Test updates: ~10 files (MeshPanel tests become view tests, entry point tests update)
- Test deletions: MeshPanel.test.tsx (283 lines) — replaced by individual view tests
- 127 files import from `features/mesh` barrel but most import `DiscoveryView` or `TopologyGraph` which remain

## 4) Root Cause Analysis

N/A — this is a consolidation/migration, not a bug fix.

## 5) Research

**Existing research incorporated:**

- `research/20260225_mesh_panel_ux_overhaul.md` — 5-tab progressive disclosure hierarchy, UX debt per tab
- `research/20260226_mesh_topology_elevation.md` — React Flow topology enhancements
- `research/20260303_command_palette_agent_centric_ux.md` — command palette navigation patterns

**Potential approaches:**

**1. Full consolidation (recommended)**

- Migrate Denied and Access as new view tabs on `/agents`
- Add AgentHealthDetail as split-pane alongside topology
- Redirect all entry points to `navigate('/agents?view=...')`
- Remove dialog infrastructure entirely
- Pros: Single source of truth, no split-brain UX, cleaner maintenance
- Cons: Larger migration scope (~15 files changed, ~5 deleted)
- Complexity: Medium
- Maintenance: Low (one surface instead of two)

**2. Partial consolidation — keep dialog as shortcut**

- Add Denied/Access to Agents page
- Keep MeshPanel dialog as a lightweight overlay that opens the same views
- Pros: Preserves "quick access from anywhere" without leaving context
- Cons: Still two surfaces to maintain, dialog becomes a thin wrapper adding complexity for little value
- Complexity: Low
- Maintenance: Medium (still two code paths)

**3. Status quo + add missing tabs**

- Just add Denied and Access to the Agents page
- Keep MeshPanel as-is
- Pros: Minimal changes
- Cons: Cements the split-brain UX, doubles maintenance burden
- Complexity: Low
- Maintenance: High (permanent duplication)

**Recommendation:** Approach 1 — Full consolidation. The MeshPanel dialog has outgrown the modal pattern (5 tabs, topology graph, detail panels, deep-link entry points). Industry consensus (Linear, GitHub, Vercel) is that surfaces this complex belong on pages. The "quick access" use case is fully served by command palette → `navigate()`.

**Key design decisions from research:**

| Topic                | Finding                                                                             | Source                                 |
| -------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- |
| Tab count            | 4 tabs is within NN/Group's 5-6 tab threshold                                       | NN/Group "Tabs, Used Right"            |
| Tab grouping         | 2+2 visual split — primary (List, Topology) and management (Denied, Access)         | NN/Group progressive disclosure        |
| Admin tab visibility | Visible always, visually muted when prerequisites not met (0 agents, <2 namespaces) | GitHub settings pattern                |
| Mobile tabs          | Collapse to `<Select>` dropdown below 640px                                         | Linear, Vercel pattern                 |
| Detail panel         | CSS flex split-pane alongside topology, not Sheet overlay                           | Kiali, Datadog APM, Grafana Node Graph |
| Mobile detail panel  | Bottom-anchored Drawer                                                              | Standard responsive pattern            |
| Command palette      | `navigate()` instead of `setOpen()`                                                 | Linear, VS Code pattern                |
| Old deep links       | TanStack Router `beforeLoad` redirect `?mesh=open` → `/agents`                      | TanStack Router docs                   |
| View state           | `validateSearch` Zod enum on route                                                  | TanStack Router search params guide    |

## 6) Decisions

| #   | Decision                   | Choice                            | Rationale                                                                                                                                                                                                               |
| --- | -------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Default view for `/agents` | `list`                            | Most actionable everyday view — users land, see agents, sort/filter/act. Topology is one click away. Matches List/Graph pattern in Linear, GitHub.                                                                      |
| 2   | Discovery placement        | Header dialog only (no tab)       | Discovery is a transient action ("scan, register, done"), not a persistent view. Keeping it as a dialog from the header button keeps the tab bar to 4 views — cleaner. Already implemented this way on the Agents page. |
| 3   | Tab set                    | List, Topology, Denied, Access    | 4 tabs — well within NN/Group's threshold. Discovery excluded (Decision 2).                                                                                                                                             |
| 4   | Rollout strategy           | Single-phase (no parallel period) | Internal app, no external consumers of `?mesh=open` deep links. Clean cut is simpler than maintaining two surfaces during a transition.                                                                                 |
