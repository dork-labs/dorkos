---
slug: mesh-panel-ux-overhaul
number: 62
created: 2026-02-25
status: ideation
---

# Mesh Panel UI/UX Overhaul

**Slug:** mesh-panel-ux-overhaul
**Author:** Claude Code
**Date:** 2026-02-25
**Branch:** preflight/mesh-panel-ux-overhaul
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Deep UX rethink of the Mesh Panel across all tabs (Topology, Discovery, Agents, Denied, Access) to create a world-class first-time and ongoing user experience. The current interface drops users onto an empty Topology graph with no guidance, Discovery requires manual path entry with no defaults or persistence, and every tab has passive empty states that offer no forward momentum.
- **Assumptions:**
  - The server boundary (`lib/boundary.ts`) is the natural default scan root — it represents the user's configured filesystem scope
  - Discovery is the keystone action — all other tabs are downstream of it
  - The existing `DirectoryPicker` component and `config-manager.ts` can be leveraged
  - No backend API changes to mesh-core are needed; only config schema additions and UI work
  - The Calm Tech design system governs all visual decisions
- **Out of scope:**
  - Backend mesh-core library changes
  - New discovery strategies or scanning algorithms
  - Relay/Pulse integration changes
  - Topology edge rendering (that's Spec 58's territory)

## 2) Pre-reading Log

- `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx`: Main panel with 5 tabs, inline DiscoveryTab/AgentsTab/DeniedTab components, disabled state messaging. 296 lines.
- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx`: React Flow graph with dagre layout, "No agents discovered yet" empty state. 105 lines.
- `apps/client/src/layers/features/mesh/ui/TopologyPanel.tsx`: Namespace groups, access rules, add-rule form. Hides form when < 2 namespaces. 240 lines.
- `apps/client/src/layers/features/mesh/ui/MeshStatsHeader.tsx`: Compact stats bar (total, active/inactive/stale counts). 39 lines.
- `apps/client/src/layers/features/mesh/ui/AgentHealthDetail.tsx`: Side panel for selected agent health. 149 lines.
- `apps/client/src/layers/features/mesh/ui/CandidateCard.tsx`: Discovery candidate card with hints, runtime, capabilities. 58 lines.
- `apps/client/src/layers/features/mesh/ui/AgentNode.tsx`: React Flow custom node rendering. 50 lines.
- `apps/client/src/layers/entities/mesh/`: 13 entity hooks covering discover, register, deny, unregister, update, topology, access, status, health, heartbeat
- `apps/client/src/layers/entities/mesh/model/use-mesh-discover.ts`: TanStack mutation wrapping `transport.discoverMeshAgents(roots, maxDepth)`
- `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`: File browser dialog with "recent" and "browse" views, localStorage view preference
- `apps/server/src/lib/boundary.ts`: Path validation — resolves symlinks, prevents traversal, returns 403 for out-of-boundary paths
- `apps/server/src/services/core/config-manager.ts`: Persistent config at `~/.dork/config.json`, atomic JSON I/O, Ajv validation
- `packages/shared/src/config-schema.ts`: UserConfigSchema (Zod), defaults, sensitive key list
- `packages/shared/src/mesh-schemas.ts`: All mesh types (AgentManifest, DiscoveryCandidate, DenialRecord, TopologyView, MeshStatus, etc.)
- `apps/server/src/routes/mesh.ts`: 15+ endpoints — POST /discover, POST/GET/PATCH/DELETE /agents, POST /deny, GET /topology, etc.
- `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx`: Reference for disabled/empty state patterns (icon + message + env var code)
- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`: Reference for tab-based organization and disabled states
- `contributing/design-system.md`: Calm Tech philosophy, color palette, typography, motion specs, 8pt grid
- `plans/mesh-specs/00-overview.md`: 4-spec plan (Core, Integration, Topology, Observability)

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx` — Main panel orchestrator (tabs, disabled gate, data loading)
- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx` — React Flow visualization with dagre layout
- `apps/client/src/layers/features/mesh/ui/TopologyPanel.tsx` — Access control (namespaces + ACL rules)
- `apps/client/src/layers/features/mesh/ui/CandidateCard.tsx` — Discovery candidate display
- `apps/client/src/layers/features/mesh/ui/MeshStatsHeader.tsx` — Compact aggregate stats
- `apps/client/src/layers/features/mesh/ui/AgentHealthDetail.tsx` — Agent health side panel

**Shared Dependencies:**

- `@/layers/shared/ui` — Badge, Tabs, TabsList, TabsTrigger, TabsContent, DirectoryPicker
- `@/layers/shared/model` — useTransport, useAppStore (recentCwds)
- `@/layers/entities/mesh` — All 13 mesh entity hooks
- `@dorkos/shared/mesh-schemas` — TypeScript types for all mesh data
- `@xyflow/react` + `dagre` — Topology graph rendering
- `motion/react` — Animations (to be added for empty states)

**Data Flow:**
User clicks "Scan" → `useDiscoverAgents` mutation → `transport.discoverMeshAgents(roots, maxDepth)` → POST `/api/mesh/discover` → `meshCore.discover()` → returns `DiscoveryCandidate[]` → rendered as `CandidateCard` list

**Feature Flags/Config:**

- `DORKOS_MESH_ENABLED` env var → `mesh-state.ts` → `useMeshEnabled()` entity hook
- `~/.dork/config.json` — will need `meshScanRoots?: string[]` added

**Potential Blast Radius:**

- Direct: 6 UI files in `features/mesh/ui/`, config schema, config route
- Indirect: DirectoryPicker (reused, not modified), entity hooks (may need config hook)
- Tests: `MeshPanel.test.tsx` needs updates for new conditional rendering logic

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

### Potential Solutions

**1. Wizard-Driven Setup**

- Description: Step-by-step modal flow on first visit (pick dirs → review candidates → set rules → done)
- Pros: Complete coverage, forces important decisions upfront
- Cons: Engineers reject hand-holding (Linear research confirms), high implementation cost, can't re-trigger if skipped
- Complexity: High
- Score: Not recommended for this developer audience

**2. Smart Defaults Only (Auto-Scan)**

- Description: Auto-detect CWD, run silent scan on first load, show results without user input
- Pros: Maximum "magic," zero friction, fast path to populated state
- Cons: Silent filesystem scanning feels invasive for a security tool, violates user consent norms
- Score: Rejected — smart defaults for input fields only, not auto-scanning

**3. Contextual Guidance Only**

- Description: Improve each tab's empty state with better copy, icons, CTAs. No pre-filling or persistence.
- Pros: Lowest risk, respects user intent, incremental shipping
- Cons: Doesn't solve root problem (blank Discovery input), no persistence means repeated friction
- Score: Necessary but not sufficient

**4. Hybrid — Smart Defaults + Contextual Guidance (RECOMMENDED)**

- Description: Pre-fill Discovery with boundary root, persist custom roots in server config, improve all empty states with contextual guidance, hide complexity until it's relevant
- Pros: Respects user intent, eliminates blank-slate problem, teaches as users explore, low-medium complexity
- Cons: Smart defaults may not match every setup, config schema addition needed
- Score: Recommended

### Security Considerations

- Server boundary in `lib/boundary.ts` enforces 403 for out-of-scope paths — UI should make boundary visible upfront
- Chip/tag input should normalize paths before sending (strip traversal, resolve `~`)
- Custom scan roots persisted in config should be validated on read

### Recommendation

**Approach 4**: Hybrid smart defaults + contextual guidance, with progressive disclosure of the full tabbed interface. The Discovery tab is the sole entry point when no agents exist.

## 6) Decisions

| #   | Decision                            | Choice                                                   | Rationale                                                                                                                                            |
| --- | ----------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What to show when zero agents exist | Hide tab bar entirely; show Discovery content full-bleed | All other tabs would be empty — the tab bar is visual noise. Discovery is the only actionable content. Progressive disclosure at the layout level.   |
| 2   | Default scan root                   | Server boundary (home directory)                         | The boundary already represents the user's configured scope. It's the natural "where to look" default. Custom roots are an advanced feature.         |
| 3   | Custom root persistence             | Server config (`~/.dork/config.json`)                    | Changing roots is an advanced action that should survive browser clearing. Add `meshScanRoots?: string[]` to UserConfigSchema.                       |
| 4   | Discovery input pattern             | Chip/tag input + DirectoryPicker button                  | Chips for quick management, folder button opens the existing DirectoryPicker for browsing. Best of both worlds.                                      |
| 5   | Topology empty state                | Hidden when zero agents                                  | Since the entire tab bar is hidden when no agents exist, Topology naturally hides too. After agents exist, Topology shows with the React Flow graph. |
| 6   | Stats header visibility             | Hidden when zero agents                                  | MeshStatsHeader has nothing to show (0/0/0) — hide it alongside the tab bar.                                                                         |
| 7   | Re-collapse behavior                | Return to Discovery-only when agents drop to 0           | If all agents are unregistered, the interface should collapse back to the simplified Discovery view.                                                 |

### Progressive Disclosure Architecture

The Mesh panel has two visual modes:

**Mode A — Zero agents (first-time / post-unregister-all):**

```
┌──────────────────────────────────────┐
│  [No tab bar]  [No stats header]     │
│                                      │
│  [Radar icon]                        │
│  Discover agents on this machine     │
│  Scan your filesystem to find        │
│  compatible AI agents.               │
│                                      │
│  [~/  ×]                       [📁]  │
│                                      │
│  [ Scan → ]                          │
│                                      │
│  (Advanced: Add custom directories)  │
└──────────────────────────────────────┘
```

**Mode B — Agents registered (full interface):**

```
┌──────────────────────────────────────┐
│  [Stats: 3 agents · 2 active · 1 …] │
│  [Topology] [Discovery] [Agents] …   │
│                                      │
│  (Active tab content)                │
│                                      │
└──────────────────────────────────────┘
```

### Tab-by-Tab Empty States (Mode B — agents exist but specific tab is empty)

**Agents tab** (if somehow empty while others exist):

```
[Users icon]
No agents registered yet
Run a discovery scan to find compatible agents.
[ Go to Discovery → ]
```

**Denied tab** (healthy empty — no CTA needed):

```
[Shield + checkmark icon]
No blocked paths
Paths you deny during discovery will appear here,
preventing those agents from joining the mesh.
```

**Access tab** (< 2 namespaces):

```
[Shield icon]
Cross-project access requires multiple namespaces
Register agents from different projects to configure
which namespaces can communicate with each other.
```

### Discovery Tab UX Details

**Scan root input:**

- Chip/tag input pre-populated with boundary path (e.g., `~/`)
- Removable chips (X button on each)
- Folder icon button opens `DirectoryPicker` dialog
- Type + Enter adds a new chip
- "Advanced" disclosure: scan depth slider (1-5, default 3)

**Default behavior:**

- On mount: pre-populate with boundary root
- If `meshScanRoots` exists in config: use those instead
- After scan: show results inline (candidates list with register/deny actions)
- "No agents found": suggest scanning with greater depth or different directories

**Persistence:**

- Custom roots saved to `~/.dork/config.json` → `meshScanRoots: string[]`
- Requires adding `meshScanRoots` to `UserConfigSchema` in `packages/shared/src/config-schema.ts`
- New server endpoint or extend existing PATCH `/api/config` to handle the field
