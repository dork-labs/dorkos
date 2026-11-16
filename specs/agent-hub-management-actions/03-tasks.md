# Agent Hub Management Actions -- Task Breakdown

**Spec:** `specs/agent-hub-management-actions/02-specification.md`
**Generated:** 2026-04-14
**Mode:** Full (4 phases, 13 tasks)

---

## Phase 1: Core Management Actions

Backend plumbing -- utility function, server endpoint, transport method, hooks, exports.

### 1.1 Add removeDorkDirectory utility (small, high)

**File:** `packages/shared/src/manifest.ts`

Add `removeDorkDirectory(projectPath)` after existing `removeManifest`. Uses `fs.stat` to check existence, `fs.readdir` to enumerate, `fs.rm` with `{ recursive: true, force: true }` to delete. Returns list of deleted file paths (e.g., `.dork/agent.json`). Returns `[]` if `.dork` does not exist. Path boundary validation is NOT in this utility -- happens at route level.

**Dependencies:** None
**Parallel with:** 1.3, 1.4, 1.5

**Acceptance:**

- Exported from `packages/shared/src/manifest.ts`
- Returns deleted file list relative to project root
- Returns `[]` if `.dork` missing
- Does not throw if already removed

---

### 1.2 Add DELETE /mesh/agents/:id/data endpoint (medium, high)

**File:** `apps/server/src/routes/mesh.ts`

New route registered BEFORE `DELETE /agents/:id` (route ordering matters). Handler: look up agent (404), guard system agents (403), get projectPath via `meshCore.getProjectPath()` (404 if missing), validate boundary (403), call `meshCore.unregister(id)` per ADR-0043, call `removeDorkDirectory(projectPath)`, emit `agent.deleted` activity event, return `{ success: true, deletedPath }`.

**Dependencies:** 1.1
**Parallel with:** None

**Acceptance:**

- 404 for non-existent agent
- 403 for system agents
- 403 for out-of-boundary paths
- Calls unregister + removeDorkDirectory on success
- Emits `agent.deleted` activity event
- Returns `{ success: true, deletedPath }`

---

### 1.3 Add deleteAgentData transport method (small, high)

**File:** `apps/client/src/layers/shared/lib/transport/mesh-methods.ts`

Add `deleteAgentData(id)` method to `createMeshMethods()` return object. Pattern: `fetchJSON(baseUrl, '/mesh/agents/${id}/data', { method: 'DELETE' })`. Returns `Promise<{ success: boolean; deletedPath: string }>`.

**Dependencies:** None
**Parallel with:** 1.1, 1.4, 1.5

**Acceptance:**

- Method added to mesh methods factory
- Uses DELETE method
- Returns typed Promise

---

### 1.4 Create useDeleteAgentData and useClearDenial hooks (small, high)

**Files:**

- `apps/client/src/layers/entities/mesh/model/use-delete-agent-data.ts`
- `apps/client/src/layers/entities/mesh/model/use-clear-denial.ts`

Both follow the existing hook pattern from `use-mesh-unregister.ts`. Use `useMutation` from `@tanstack/react-query`, `useTransport()` from `@/layers/shared/model`.

- `useDeleteAgentData`: calls `transport.deleteAgentData(id)`, invalidates `['mesh', 'agents']` and `['mesh', 'topology']`
- `useClearDenial`: calls `transport.clearMeshDenial(path)`, invalidates `['mesh', 'denied']`

**Dependencies:** None
**Parallel with:** 1.1, 1.3, 1.5

**Acceptance:**

- Both hooks use standard mutation pattern
- Correct query invalidation on success
- TSDoc comments present

---

### 1.5 Update mesh entity barrel exports (small, high)

**File:** `apps/client/src/layers/entities/mesh/index.ts`

Add exports: `useDeleteAgentData` from `./model/use-delete-agent-data`, `useClearDenial` from `./model/use-clear-denial`.

**Dependencies:** 1.4
**Parallel with:** 1.1, 1.3

**Acceptance:**

- Both hooks importable from `@/layers/entities/mesh`

---

## Phase 2: AgentHub UI

New components and hero integration.

### 2.1 Create AgentManagementMenu component (medium, high)

**File:** `apps/client/src/layers/features/agent-hub/ui/AgentManagementMenu.tsx`

DropdownMenu with three items: Deny/Unblock toggle, Unregister (with undo toast), Delete Agent & Data (opens dialog via `onDeleteRequest` prop). Uses `useAgentHubContext()` for agent data. Hides destructive items for system agents. Unregister shows Sonner undo toast with 5-second duration; undo calls `useRegisterAgent()`.

**Dependencies:** 1.4, 1.5
**Parallel with:** 2.2

**Acceptance:**

- All items render for regular agents
- Destructive items hidden for system agents
- Deny/Unblock toggles based on denied state
- Undo toast on unregister
- `onDeleteRequest` called for delete action

---

### 2.2 Create DeleteAgentDialog component (medium, high)

**File:** `apps/client/src/layers/features/agent-hub/ui/DeleteAgentDialog.tsx`

Type-to-confirm AlertDialog. Props: `agentId`, `agentName`, `projectPath`, `open`, `onOpenChange`. Shows list of `.dork` contents that will be deleted. Delete button disabled until input matches agent name (case-sensitive). On confirm: calls `useDeleteAgentData().mutate(agentId)`, shows destructive toast, closes dialog.

**Dependencies:** 1.4, 1.5
**Parallel with:** 2.1

**Acceptance:**

- Delete button disabled until name matches
- Calls delete mutation on confirm
- Destructive toast on success
- Input resets on open/close

---

### 2.3 Integrate AgentManagementMenu into AgentHubHero (medium, high)

**File:** `apps/client/src/layers/features/agent-hub/ui/AgentHubHero.tsx`

Add `AgentManagementMenu` trigger at top-right of hero (absolute positioned, below RightPanelHeader). Add `DeleteAgentDialog` controlled by local state. Destructure `projectPath` from `useAgentHubContext()`.

**Dependencies:** 2.1, 2.2
**Parallel with:** None

**Acceptance:**

- Three-dot button visible at top-right of hero
- Menu opens on click
- Delete dialog opens from menu
- Existing hero layout/animations unaffected

---

### 2.4 Update agent-hub barrel exports (small, medium)

**File:** `apps/client/src/layers/features/agent-hub/index.ts`

Add exports: `AgentManagementMenu`, `DeleteAgentDialog`.

**Dependencies:** 2.1, 2.2
**Parallel with:** 2.3

**Acceptance:**

- Both components importable from `@/layers/features/agent-hub`

---

## Phase 3: AgentsList Navigation

Replace overflow menu with split Chat + Manage buttons.

### 3.1 Replace Actions column with split buttons (medium, high)

**File:** `apps/client/src/layers/features/agents-list/lib/agent-columns.tsx`

Update `AgentColumnCallbacks` to 3 callbacks: `onNavigate`, `onManage`, `onStartSession`. Remove `onEdit`, `onSetDefault`, `onUnregister`. Replace the entire Actions column with two icon buttons: Chat (MessageSquare icon) and Manage (Settings icon). Remove unused imports (DropdownMenu, Tooltip, old icons).

**Dependencies:** None
**Parallel with:** None

**Acceptance:**

- Interface has exactly 3 callbacks
- Two icon buttons per row (Chat + Manage)
- Proper aria-labels
- No overflow menu
- No unused imports

---

### 3.2 Wire onManage in AgentsList, remove unused handlers (medium, high)

**File:** `apps/client/src/layers/features/agents-list/ui/AgentsList.tsx`

Add `handleManage` callback (same logic as current `handleEdit`). Remove `handleEdit`, `handleSetDefault`, `handleUnregister`, `unregisterTarget` state. Remove `UnregisterAgentDialog` rendering. Update `createAgentColumns()` call to pass new 3-callback interface.

**Dependencies:** 3.1
**Parallel with:** None

**Acceptance:**

- `createAgentColumns` receives `onNavigate`, `onManage`, `onStartSession`
- `handleManage` opens AgentHub panel
- No UnregisterAgentDialog rendered
- No unused state/callbacks/imports

---

## Phase 4: Tests

### 4.1 Server tests for DELETE /mesh/agents/:id/data (medium, high)

**File:** `apps/server/src/routes/__tests__/mesh.test.ts`

Add `getProjectPath` to mock MeshCore. Mock `removeDorkDirectory`. Test: 404 not found, 403 system agent, 403 boundary, 404 no project path, 200 success (verifies unregister + removeDorkDirectory called, response body correct).

**Dependencies:** 1.2
**Parallel with:** 4.2, 4.3, 4.4

---

### 4.2 Unit tests for removeDorkDirectory (small, high)

**File:** `packages/shared/src/__tests__/manifest.test.ts`

Mock `fs/promises`. Test: recursive deletion, empty array when missing, empty array when not directory, no throw when stat fails.

**Dependencies:** 1.1
**Parallel with:** 4.1, 4.3, 4.4

---

### 4.3 Component tests for AgentManagementMenu and DeleteAgentDialog (medium, high)

**Files:**

- `apps/client/src/layers/features/agent-hub/__tests__/AgentManagementMenu.test.tsx`
- `apps/client/src/layers/features/agent-hub/__tests__/DeleteAgentDialog.test.tsx`

Follow pattern from `UnregisterAgentDialog.test.tsx`. Mock entity hooks, agent-hub context, sonner. Test: menu items visible/hidden, system agent guard, mutations called, dialog confirmation gating, destructive styling.

**Dependencies:** 2.1, 2.2
**Parallel with:** 4.1, 4.2, 4.4

---

### 4.4 Update agent-columns and AgentsList tests (medium, high)

**Files:**

- `apps/client/src/layers/features/agents-list/__tests__/AgentsList.test.tsx`
- `apps/client/src/layers/features/agents-list/__tests__/AgentRow.test.tsx`

Update callback interface references to new 3-callback shape. Remove tests for removed callbacks/dialog. Add tests for Chat and Manage button rendering and click behavior.

**Dependencies:** 3.1, 3.2
**Parallel with:** 4.1, 4.2, 4.3

---

## Dependency Graph

```
Phase 1 (parallel starts):
  1.1 ──────────────┐
  1.3 (parallel)    │
  1.4 (parallel) ───┤
  1.5 (after 1.4)   │
                    ▼
  1.2 (after 1.1) ──► Phase 2

Phase 2:
  2.1 + 2.2 (parallel, after 1.4+1.5)
  2.3 (after 2.1+2.2)
  2.4 (parallel with 2.3)

Phase 3 (independent of Phase 2):
  3.1 ──► 3.2

Phase 4 (after respective implementation tasks):
  4.1 (after 1.2)  ┐
  4.2 (after 1.1)  │ all parallel
  4.3 (after 2.1+2.2) │
  4.4 (after 3.1+3.2) ┘
```

## Size Summary

| Size      | Count  |
| --------- | ------ |
| Small     | 5      |
| Medium    | 8      |
| Large     | 0      |
| **Total** | **13** |
