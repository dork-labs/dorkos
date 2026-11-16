---
slug: agent-hub-management-actions
number: 243
created: 2026-04-14
status: specified
---

# Agent Hub Management Actions

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-04-14
**Ideation:** `specs/agent-hub-management-actions/01-ideation.md`

---

## Overview

Surface agent lifecycle management actions (unregister, deny/block, delete data) in the AgentHub panel and add split navigation buttons to the AgentsList for quick access to both chat and management. The backend already supports these operations but the AgentHub has zero management actions today — it's purely identity/config editing.

## Background / Problem Statement

The AgentHub right-panel (`AgentHubHero.tsx`) displays agent identity, personality, configuration, and toolkit — but provides no way to manage the agent's lifecycle. Users who want to unregister, deny, or delete an agent must navigate to the agents-list table, which only exposes unregister (via an overflow menu), and doesn't expose deny or delete-data at all.

Current state of agent management across surfaces:

| Action             | Backend                     | Client Hook                    | UI                            |
| ------------------ | --------------------------- | ------------------------------ | ----------------------------- |
| Unregister         | `DELETE /mesh/agents/:id`   | `useUnregisterAgent()`         | AgentsList overflow menu only |
| Deny/Block         | `POST /mesh/deny`           | `useDenyAgent()`               | None                          |
| Clear denial       | `DELETE /mesh/denied/:path` | None (transport method exists) | None                          |
| Delete `.dork` dir | Not implemented             | Not implemented                | Not implemented               |

## Goals

- Add a three-dot overflow menu in the AgentHub hero with Deny/Block, Unregister, and Delete Agent & Data actions
- Add split navigation buttons (Chat + Manage) to each agent row in the AgentsList
- Implement server-side `.dork` directory deletion with path boundary validation
- Create missing client hooks (`useDeleteAgentData`, `useClearDenial`)
- Use undo toast for reversible actions, type-to-confirm for irreversible ones
- Protect system agents by hiding destructive menu items

## Non-Goals

- Bulk agent management (multi-select, batch unregister)
- Agent archival or pause states
- Export agent config before deletion
- Deny action in the discovery flow (separate feature)
- Changes to the existing MeshPanel Denied tab

## Technical Dependencies

- `@radix-ui/react-dropdown-menu` — DropdownMenu (already in shared/ui)
- `@radix-ui/react-alert-dialog` — AlertDialog (already in shared/ui)
- `sonner` — toast notifications (already installed)
- `lucide-react` — icons: `MoreVertical`, `MessageSquare`, `Settings`, `ShieldBan`, `Unplug`, `Trash2` (already installed)
- `@tanstack/react-query` — mutations and cache invalidation (already installed)

No new dependencies required.

## Detailed Design

### 1. AgentManagementMenu Component

**File:** `apps/client/src/layers/features/agent-hub/ui/AgentManagementMenu.tsx`

A DropdownMenu rendered in the AgentHubHero section. Reads agent state from `useAgentHubContext()`.

```tsx
interface AgentManagementMenuProps {
  className?: string;
}
```

**Menu structure:**

```
┌─────────────────────────┐
│ ■ Deny Agent            │  ← toggles to "Unblock Agent" if denied
│ ■ Unregister            │  ← hidden for system agents
├─────────────────────────┤
│ ■ Delete Agent & Data   │  ← red text, hidden for system agents
└─────────────────────────┘
```

**Behavior:**

- **Deny/Block**: Calls `useDenyAgent()` with the agent's project path. If agent is already denied, shows "Unblock Agent" and calls `useClearDenial()` instead. Single click, no dialog — shows success toast.
- **Unregister**: Calls `useUnregisterAgent()` immediately (no dialog). Shows Sonner undo toast: `"Agent {name} unregistered"` with an "Undo" action button. On undo, calls `useRegisterAgent()` with the original project path to re-register. Toast auto-dismisses after 5 seconds.
- **Delete Agent & Data**: Opens `DeleteAgentDialog` (see below).

**System agent guard:** If `agent.isSystem === true`, hide Unregister and Delete Agent & Data items entirely. Deny/Block may also be hidden for system agents (dorkbot should not be blockable).

**Placement in AgentHubHero:** Render the trigger button (⋮) at the top-right corner of the hero section, positioned absolutely within the hero's relative container.

### 2. DeleteAgentDialog Component

**File:** `apps/client/src/layers/features/agent-hub/ui/DeleteAgentDialog.tsx`

A type-to-confirm AlertDialog for irreversible `.dork` directory deletion.

```tsx
interface DeleteAgentDialogProps {
  agentId: string;
  agentName: string;
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

**Dialog content:**

- **Title:** "Delete {agentName} & Data"
- **Description:** "This will permanently delete the `.dork` directory at `{projectPath}/.dork/`, including:"
  - `agent.json` — agent manifest
  - `SOUL.md` — personality convention
  - `NOPE.md` — restriction convention
  - Any other convention files
- **Confirmation input:** "Type **{agentName}** to confirm"
- **Actions:** Cancel (outline) + "Delete Agent & Data" (destructive, disabled until name matches)

**On confirm:** Calls `useDeleteAgentData()` mutation. On success, closes dialog, shows destructive toast, navigates away from the agent (since it no longer exists).

### 3. Split Navigation Buttons in AgentsList

**File:** `apps/client/src/layers/features/agents-list/lib/agent-columns.tsx`

Modify the existing Actions column (column 7). Currently renders an Edit button + overflow menu with Start Session, Set as Default, and Unregister.

**New layout:** Replace the current actions cell with two icon buttons:

```tsx
// Cell content
<div className="flex items-center justify-end gap-1">
  <Button
    variant="ghost"
    size="sm"
    className="size-8 p-0"
    onClick={() => callbacks.onStartSession(row.original.projectPath)}
    aria-label={`Chat with ${row.original.displayName}`}
  >
    <MessageSquare className="size-4" />
  </Button>
  <Button
    variant="ghost"
    size="sm"
    className="size-8 p-0"
    onClick={() => callbacks.onManage(row.original.projectPath)}
    aria-label={`Manage ${row.original.displayName}`}
  >
    <Settings className="size-4" />
  </Button>
</div>
```

**Callbacks change:** Add `onManage: (projectPath: string) => void` to `AgentColumnCallbacks`. Remove the overflow menu entirely — all management actions now live in the AgentHub.

The existing `onEdit`, `onSetDefault`, and `onUnregister` callbacks can be removed from `AgentColumnCallbacks` since they're no longer used in the columns. The parent component (`AgentsList`) should wire `onManage` to open the AgentHub panel for that agent (set the agent hub store's selected path and open the right panel).

### 4. Server Endpoint: Delete Agent Data

**File:** `apps/server/src/routes/mesh.ts`

Add a new endpoint that unregisters the agent AND deletes the `.dork` directory:

```
DELETE /mesh/agents/:id/data
```

**Handler logic:**

1. Look up agent by ID → 404 if not found
2. Guard system agents → 403 if `isSystem`
3. Get the agent's project path from the registry
4. Validate path boundary via `validateBoundary(projectPath)` → 403 if outside sandbox
5. Call `meshCore.unregister(id)` — handles write-through deletion per ADR-0043
6. Call `removeDorkDirectory(projectPath)` — removes the entire `.dork/` directory
7. Emit activity event: `agent.deleted` with summary `"Deleted agent {name} and data"`
8. Return `{ success: true, deletedPath: projectPath + '/.dork' }`

**Why a separate endpoint vs query param:** A distinct resource path (`/data`) makes intent explicit in logs and audit trails. The existing `DELETE /mesh/agents/:id` continues to work unchanged for unregister-only.

### 5. removeDorkDirectory Utility

**File:** `packages/shared/src/manifest.ts`

```typescript
/**
 * Remove the entire `.dork` directory for an agent project.
 * Validates the path resolves within the project before deletion.
 *
 * @param projectPath - Absolute path to the project directory
 * @returns List of files that were deleted
 */
export async function removeDorkDirectory(projectPath: string): Promise<string[]> {
  const dorkPath = path.join(projectPath, MANIFEST_DIR);

  // Verify .dork exists and is a directory
  const stat = await fs.stat(dorkPath).catch(() => null);
  if (!stat?.isDirectory()) return [];

  // Enumerate files for response (before deletion)
  const entries = await fs.readdir(dorkPath, { recursive: true });

  // Remove recursively
  await fs.rm(dorkPath, { recursive: true, force: true });

  return entries.map((e) => path.join(MANIFEST_DIR, String(e)));
}
```

Path boundary validation happens at the route level (using `validateBoundary()`), not inside this utility. The utility is a focused file operation.

### 6. Client Hook: useDeleteAgentData

**File:** `apps/client/src/layers/entities/mesh/model/use-delete-agent-data.ts`

```typescript
export function useDeleteAgentData() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => transport.deleteAgentData(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
      queryClient.invalidateQueries({ queryKey: ['mesh', 'topology'] });
    },
  });
}
```

### 7. Client Hook: useClearDenial

**File:** `apps/client/src/layers/entities/mesh/model/use-clear-denial.ts`

```typescript
export function useClearDenial() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (path: string) => transport.clearMeshDenial(path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesh', 'denied'] });
    },
  });
}
```

### 8. Transport Method: deleteAgentData

**File:** `apps/client/src/layers/shared/lib/transport/mesh-methods.ts`

Add to the object returned by `createMeshMethods()`:

```typescript
async deleteAgentData(id: string): Promise<{ success: boolean; deletedPath: string }> {
  return fetchJSON(baseUrl, `/mesh/agents/${id}/data`, { method: 'DELETE' });
}
```

### 9. Barrel Export Updates

**File:** `apps/client/src/layers/entities/mesh/index.ts`

Add:

```typescript
export { useDeleteAgentData } from './model/use-delete-agent-data';
export { useClearDenial } from './model/use-clear-denial';
```

**File:** `apps/client/src/layers/features/agent-hub/index.ts`

Add:

```typescript
export { AgentManagementMenu } from './ui/AgentManagementMenu';
export { DeleteAgentDialog } from './ui/DeleteAgentDialog';
```

## Data Flow

### Unregister (with undo)

```
User clicks "Unregister" in menu
  → useUnregisterAgent().mutate(id)
  → DELETE /mesh/agents/:id
  → meshCore.unregister(id)
    → removeManifest(projectPath)     [disk first — ADR-0043]
    → registry.remove(id)             [DB second]
    → relayBridge.unregisterAgent(id) [cleanup Relay]
    → onUnregisterCallbacks           [cascade-disable Tasks — ADR-0072]
  → toast("Agent unregistered", { action: "Undo" })

If user clicks "Undo" within 5s:
  → useRegisterAgent().mutate(projectPath)
  → POST /mesh/agents { path: projectPath }
  → meshCore.register(projectPath)    [re-creates manifest + DB entry]
```

### Delete Agent & Data

```
User clicks "Delete Agent & Data" → types agent name → confirms
  → useDeleteAgentData().mutate(id)
  → DELETE /mesh/agents/:id/data
  → meshCore.unregister(id)           [same as above]
  → removeDorkDirectory(projectPath)  [rm -rf .dork/]
  → activity: agent.deleted event
  → close AgentHub panel, navigate away
```

### Deny / Unblock

```
User clicks "Deny Agent":
  → useDenyAgent().mutate({ path, reason: 'Blocked via AgentHub' })
  → POST /mesh/deny { path, reason, denier }
  → meshCore.deny(path, reason, denier)
  → toast.success("Agent blocked")

User clicks "Unblock Agent" (if already denied):
  → useClearDenial().mutate(path)
  → DELETE /mesh/denied/:encodedPath
  → meshCore.undeny(path)
  → toast.success("Agent unblocked")
```

## User Experience

### AgentHub Hero (after change)

The hero section gains a subtle ⋮ button at top-right. Clicking it opens a dropdown with management actions. For system agents (dorkbot), only non-destructive items appear. For regular agents, the full menu is available with destructive actions visually separated.

### AgentsList (after change)

Each agent row shows two icon buttons at the right edge:

- **Chat** (speech bubble) — immediately opens a new session
- **Manage** (gear) — opens the AgentHub right panel for that agent

This replaces the current Edit button + overflow menu pattern. The intent is faster navigation with less ambiguity.

### Deletion Flow

1. Click ⋮ → "Delete Agent & Data"
2. AlertDialog appears with explicit list of `.dork` contents
3. Type agent name to enable the destructive button
4. Click "Delete Agent & Data"
5. Agent is unregistered, `.dork` directory removed, panel closes
6. Toast confirms deletion

## Testing Strategy

### Unit Tests

**AgentManagementMenu:**

- Renders all menu items for regular agents
- Hides Unregister and Delete for system agents
- Shows "Unblock Agent" when agent is denied
- Calls correct mutation on each menu item click
- Triggers undo toast on unregister

**DeleteAgentDialog:**

- Renders with agent name and path info
- Delete button disabled until name matches (case-sensitive)
- Calls `useDeleteAgentData` on confirm
- Closes dialog and shows toast on success

**Split buttons in agent-columns:**

- Renders Chat and Manage buttons for each row
- Chat button calls `onStartSession` with correct path
- Manage button calls `onManage` with correct path

### Service Tests

**DELETE /mesh/agents/:id/data:**

- Returns 404 for non-existent agent
- Returns 403 for system agents
- Returns 403 for paths outside boundary
- Successfully unregisters and deletes `.dork` directory
- Emits `agent.deleted` activity event
- Returns `{ success: true, deletedPath }` on success

**removeDorkDirectory:**

- Deletes `.dork` directory recursively
- Returns list of deleted files
- Returns empty array if `.dork` doesn't exist
- Does not throw if directory already removed

### Hook Tests

**useDeleteAgentData:**

- Calls correct transport method
- Invalidates `['mesh', 'agents']` and `['mesh', 'topology']` on success

**useClearDenial:**

- Calls `clearMeshDenial` transport method
- Invalidates `['mesh', 'denied']` on success

## Performance Considerations

- `.dork` directory deletion is a filesystem operation — typically fast for small directories (a few files), but `fs.rm` with `recursive: true` handles any size
- Undo toast pattern avoids blocking the UI with a confirmation dialog for the common unregister case
- No new polling or background queries introduced
- Query invalidation is targeted (specific query keys, not blanket invalidation)

## Security Considerations

- **Path boundary validation:** The delete-data endpoint validates the agent's project path via `validateBoundary()` before any filesystem operation. This prevents directory traversal attacks.
- **System agent protection:** System agents return 403 on both unregister and delete-data. The client hides menu items for defense-in-depth.
- **No project file deletion:** `removeDorkDirectory` only targets the `.dork` subdirectory. The utility constructs the path as `path.join(projectPath, '.dork')` — it cannot be manipulated to delete parent directories.
- **Type-to-confirm for irreversible actions:** The delete dialog requires exact agent name input, preventing accidental clicks.

## Implementation Phases

### Phase 1: Core Management Actions

1. Create `removeDorkDirectory()` utility in `packages/shared/src/manifest.ts`
2. Add `DELETE /mesh/agents/:id/data` endpoint in `apps/server/src/routes/mesh.ts`
3. Add `deleteAgentData()` transport method in `mesh-methods.ts`
4. Create `useDeleteAgentData` and `useClearDenial` hooks
5. Update mesh entity barrel exports

### Phase 2: AgentHub UI

6. Create `AgentManagementMenu` component
7. Create `DeleteAgentDialog` component
8. Integrate overflow menu into `AgentHubHero.tsx`
9. Update agent-hub barrel exports

### Phase 3: AgentsList Navigation

10. Add `onManage` callback to `AgentColumnCallbacks`
11. Replace Actions column with split Chat + Manage buttons
12. Wire `onManage` in `AgentsList` to open AgentHub panel
13. Remove unused callbacks (`onEdit`, `onSetDefault`, `onUnregister`) from columns

### Phase 4: Tests

14. Add server tests for `DELETE /mesh/agents/:id/data` endpoint
15. Add unit tests for `removeDorkDirectory`
16. Add component tests for `AgentManagementMenu` and `DeleteAgentDialog`
17. Update existing `agent-columns` tests for new button layout

## Open Questions

None — all decisions were resolved during ideation (see `01-ideation.md` Section 6).

## Related ADRs

- **ADR-0043:** File as canonical source of truth for mesh registry — governs write-through deletion order (disk first, then DB)
- **ADR-0072:** Cascade disable on agent unregister — Task schedules auto-disabled when agent removed
- **ADR-0166:** Remove MeshPanel Agents tab — confirms `/agents` page (and by extension AgentHub) is the single agent management surface

## References

- Ideation: `specs/agent-hub-management-actions/01-ideation.md`
- AgentHub hero: `apps/client/src/layers/features/agent-hub/ui/AgentHubHero.tsx`
- Agent columns: `apps/client/src/layers/features/agents-list/lib/agent-columns.tsx`
- Manifest utilities: `packages/shared/src/manifest.ts`
- Mesh routes: `apps/server/src/routes/mesh.ts`
- Mesh transport: `apps/client/src/layers/shared/lib/transport/mesh-methods.ts`
- Existing unregister hook: `apps/client/src/layers/entities/mesh/model/use-mesh-unregister.ts`
- Existing deny hook: `apps/client/src/layers/entities/mesh/model/use-mesh-deny.ts`
