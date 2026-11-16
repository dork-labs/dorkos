---
slug: agent-hub-management-actions
number: 243
created: 2026-04-14
status: ideation
---

# Agent Hub Management Actions

**Slug:** agent-hub-management-actions
**Author:** Claude Code
**Date:** 2026-04-14
**Branch:** preflight/agent-hub-management-actions

---

## 1) Intent & Assumptions

- **Task brief:** Surface agent management actions (unregister, delete data, deny/block) in the AgentHub panel, and add a quick navigation path from the AgentsList to the AgentHub. Currently the backend supports these operations but the AgentHub has zero management actions — it's purely identity/config editing.
- **Assumptions:**
  - Management actions live exclusively in the AgentHub (not duplicated in the agents-list table)
  - The AgentsList gets split primary buttons for quick navigation: Chat vs Manage (opens AgentHub)
  - System agents (isSystem: true) remain protected — cannot be unregistered or deleted
  - "Delete Agent & Data" means deleting the `.dork` directory only, not the project's source files
  - The existing write-through pattern (ADR-0043) governs all mutations: disk first, then DB
- **Out of scope:**
  - Bulk agent management (select multiple, batch unregister)
  - Agent archival/pause state (beyond deny)
  - Export agent config before deletion
  - Deny action UI in the discovery flow (separate feature)

## 2) Pre-reading Log

- `apps/client/src/layers/features/agent-hub/ui/AgentHub.tsx`: Right-panel hub with 3 tabs (Sessions, Config, Toolkit) and hero section with avatar/personality. No management actions.
- `apps/client/src/layers/features/agents-list/ui/AgentsList.tsx`: Agent fleet table with row actions. Unregister button exists here.
- `apps/client/src/layers/features/agents-list/ui/UnregisterAgentDialog.tsx`: Existing unregister confirmation dialog.
- `apps/client/src/layers/features/agents-list/ui/DeniedView.tsx`: Read-only list of denied paths. No clear-denial buttons.
- `apps/client/src/layers/entities/mesh/model/use-mesh-unregister.ts`: Client hook for unregister mutation.
- `apps/client/src/layers/entities/mesh/model/use-mesh-deny.ts`: Client hook for deny mutation. No UI uses it.
- `apps/client/src/layers/shared/lib/transport/mesh-methods.ts`: Transport layer with `unregisterMeshAgent`, `denyMeshAgent`, `clearMeshDenial` HTTP methods.
- `apps/server/src/routes/mesh.ts`: Full mesh API — DELETE `/mesh/agents/:id` (unregister), POST `/mesh/deny`, DELETE `/mesh/denied/:encodedPath` (undeny).
- `apps/server/src/routes/agents.ts`: Agent identity CRUD. No DELETE endpoint.
- `packages/mesh/src/mesh-agent-management.ts`: Core lifecycle — `unregister()` deletes `.dork/agent.json`, removes from registry, unregisters Relay endpoint, fires callbacks (cascade-disable Tasks).
- `packages/mesh/src/mesh-denial.ts`: `deny()`, `undeny()`, `listDenied()` operations.
- `packages/shared/src/manifest.ts`: `removeManifest(path)` deletes `.dork/agent.json` only — not the entire `.dork` directory.
- `contributing/design-system.md`: Calm Tech design language.
- `research/20260320_agents_page_ux_patterns.md`: Validated dense-list with expandable rows as correct layout for agent fleet.
- `research/20260322_agents_page_fleet_management_ux_deep_dive.md`: Fleet management UX deep dive.

## 3) Codebase Map

**Primary Components/Modules:**

| Path                                                                       | Role                                                                |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/client/src/layers/features/agent-hub/ui/AgentHub.tsx`                | Right-panel hub — target for management actions                     |
| `apps/client/src/layers/features/agent-hub/ui/AgentHubHero.tsx`            | Hero section (avatar, name, personality) — target for overflow menu |
| `apps/client/src/layers/features/agents-list/ui/AgentsList.tsx`            | Fleet table — target for split navigation buttons                   |
| `apps/client/src/layers/features/agents-list/lib/agent-columns.tsx`        | Column definitions — where split buttons would be added             |
| `apps/client/src/layers/features/agents-list/ui/UnregisterAgentDialog.tsx` | Existing unregister confirmation — can be reused or adapted         |
| `apps/client/src/layers/entities/mesh/model/use-mesh-unregister.ts`        | Unregister mutation hook                                            |
| `apps/client/src/layers/entities/mesh/model/use-mesh-deny.ts`              | Deny mutation hook                                                  |
| `apps/client/src/layers/shared/lib/transport/mesh-methods.ts`              | HTTP transport for all mesh operations                              |
| `packages/mesh/src/mesh-agent-management.ts`                               | Server-side agent lifecycle (unregister, update)                    |
| `packages/mesh/src/mesh-denial.ts`                                         | Server-side denial management                                       |
| `packages/shared/src/manifest.ts`                                          | Disk I/O for `.dork/agent.json`                                     |
| `apps/server/src/routes/mesh.ts`                                           | Mesh API routes                                                     |

**Shared Dependencies:**

- `@/layers/shared/ui` — AlertDialog, Button, DropdownMenu, Sonner toast
- `@/layers/shared/lib/transport` — Transport interface for API calls
- `@tanstack/react-query` — Cache invalidation on mutations
- `packages/shared/src/mesh-schemas.ts` — Agent manifest Zod schemas

**Data Flow:**

```
AgentHub UI → mutation hook → transport method → HTTP route → mesh service → disk + DB
```

Specifically:

- Unregister: `useUnregisterAgent()` → `DELETE /mesh/agents/:id` → `meshCore.unregister()` → delete `.dork/agent.json` + remove from registry + unregister Relay + cascade-disable Tasks
- Delete data (new): needs new endpoint → `rm -rf .dork/` at agent's project path
- Deny: `useDenyAgent()` → `POST /mesh/deny` → `meshCore.deny()` → add to denial list

**Feature Flags/Config:**

- Mesh is always enabled (ADR-0062)
- System agents are protected via `isSystem: boolean` flag in manifest

**Potential Blast Radius:**

- Direct: AgentHubHero (add overflow menu), agent-columns (add split buttons), new delete-data endpoint
- New components: `AgentManagementMenu` (overflow menu), `DeleteAgentDialog` (type-to-confirm)
- New server code: DELETE endpoint for `.dork` directory, `removeDorkDirectory()` utility
- New client hook: `useDeleteAgentData()` mutation
- Tests: AgentHub tests, agents-list tests, mesh route tests, mesh service tests

## 4) Root Cause Analysis

N/A — this is a feature, not a bug fix.

## 5) Research

### Potential Approaches

**1. Three-Dot Overflow Menu in AgentHub Hero**

- Description: A kebab menu (⋮) in the AgentHub hero section containing Unregister, Deny/Block, and Delete Agent & Data actions.
- Pros: Clean — no visual clutter until needed; familiar pattern (Linear, GitHub, Vercel); destructive actions separated at bottom with red text and divider; works well with 3-5 actions.
- Cons: Requires hover/click to discover; not visible at a glance.
- Complexity: Low
- Maintenance: Low

**2. Dedicated "Danger Zone" Section in Config Tab**

- Description: A red-bordered section at the bottom of the Config tab with management buttons.
- Pros: Very discoverable; follows GitHub repo settings pattern.
- Cons: Buries actions in a tab; mixes config editing with destructive operations; heavier UI weight.
- Complexity: Low
- Maintenance: Low

**3. Action Bar Below Hero**

- Description: Always-visible button bar under the hero with icon buttons for each action.
- Pros: Most discoverable; one-click access.
- Cons: Takes vertical space; destructive actions always visible increases accidental trigger risk; cluttered.
- Complexity: Low
- Maintenance: Low

### Destructive Action Best Practices (from research)

| Action              | Reversibility                              | Confirmation Pattern                                        |
| ------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| Deny/Block          | Reversible (can unblock)                   | Inline toggle or single-click with undo toast               |
| Unregister          | Reversible (re-discoverable via mesh scan) | Undo toast — "Agent [name] unregistered · Undo" (5s window) |
| Delete Agent & Data | Irreversible                               | Type-to-confirm dialog listing what will be destroyed       |

### Recommendation

**Recommended: Approach 1 — Three-dot overflow menu in AgentHub hero.** It keeps the hero clean, follows established patterns, and naturally separates destructive actions via menu dividers and red text. The undo toast for unregister (Gmail/Notion pattern) is superior to a confirmation dialog for reversible actions.

## 6) Decisions

| #   | Decision                         | Choice                                                                                                    | Rationale                                                                                                                                                                                     |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where management actions live    | AgentHub only                                                                                             | Single surface area; agents-list stays focused on navigation. User preference.                                                                                                                |
| 2   | AgentsList → AgentHub navigation | Split buttons: Chat icon + Gear icon per row                                                              | Instant, no menus, no ambiguity. Linear-style pattern. Each row gets two always-visible icon buttons.                                                                                         |
| 3   | Delete behavior                  | Two-tier: Unregister (undo toast) + Delete Agent & Data (type-to-confirm, deletes `.dork` directory only) | Unregister is reversible (agent can be re-discovered). Delete is irreversible but scoped to `.dork` metadata only — never touches project source files. User explicitly confirmed this scope. |
| 4   | Management menu placement        | Three-dot overflow menu in AgentHub hero section                                                          | Clean, familiar pattern. Destructive actions at bottom with divider + red text.                                                                                                               |
| 5   | Unregister confirmation          | Undo toast (5s window), no dialog                                                                         | Reversible action — toast is faster UX than a dialog. Agent reappears on next mesh scan if needed.                                                                                            |
| 6   | Delete confirmation              | Type-to-confirm dialog                                                                                    | Irreversible. Dialog explicitly lists contents being destroyed (SOUL.md, NOPE.md, conventions, agent.json). User types agent name to confirm.                                                 |
| 7   | System agent protection          | Hide destructive actions for system agents                                                                | System agents (isSystem: true, e.g. dorkbot) cannot be unregistered or deleted. Hide menu items rather than showing disabled state.                                                           |

---

## Implementation Notes

### New Server-Side Work

1. **New utility: `removeDorkDirectory(projectPath)`** in `packages/shared/src/manifest.ts`
   - `rm -rf <projectPath>/.dork/`
   - Validates path is within allowed boundaries before deletion
   - Returns list of files deleted for the confirmation response

2. **New or extended endpoint** for delete-with-data
   - Option A: Extend `DELETE /mesh/agents/:id` with `?deleteData=true` query param
   - Option B: New `DELETE /mesh/agents/:id/data` endpoint
   - Must call `unregister()` first, then `removeDorkDirectory()`
   - Must guard system agents

### New Client-Side Work

1. **`AgentManagementMenu`** component in `features/agent-hub/ui/`
   - Three-dot DropdownMenu with: Deny/Block, Unregister, divider, Delete Agent & Data
   - Conditionally hides items for system agents
   - Placed in AgentHubHero

2. **`DeleteAgentDialog`** component in `features/agent-hub/ui/`
   - AlertDialog with type-to-confirm (agent display name)
   - Lists `.dork` directory contents being deleted
   - Uses `text-destructive` styling

3. **`useDeleteAgentData()`** mutation hook in `entities/mesh/model/`
   - Calls the new delete-data endpoint
   - Invalidates mesh agent queries on success

4. **`useClearDenial()`** hook in `entities/mesh/model/`
   - Wraps existing `clearMeshDenial()` transport method (backend already exists, hook is missing)

5. **Split buttons in agent-columns.tsx**
   - Chat icon button → starts session with agent
   - Gear icon button → opens AgentHub panel for agent

### Undo Toast for Unregister

- Use Sonner toast with "Undo" action button
- On undo: re-register agent via `POST /mesh/agents` with the same path
- 5-second window before toast auto-dismisses
- After dismissal, unregister is committed (already happened server-side; undo re-registers)
