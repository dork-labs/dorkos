# Settings Reset & Server Restart — Task Breakdown

**Spec**: `specs/settings-reset-restart/02-specification.md`
**Generated**: 2026-03-01

## Summary

7 tasks across 3 phases. Estimated total: ~4-6 hours of implementation.

| Phase | Name                       | Tasks                      |
| ----- | -------------------------- | -------------------------- |
| 1     | Server Infrastructure      | 1 task                     |
| 2     | Transport & Client UI      | 4 tasks (3 parallelizable) |
| 3     | Reconnection & Integration | 2 tasks                    |

---

## Phase 1: Server Infrastructure

### Task 1.1 — Create admin route with reset and restart endpoints `[large]`

**Dependencies**: None

Create `apps/server/src/routes/admin.ts` with:

- `POST /api/admin/reset` — validates `{ confirm: 'reset' }`, responds 200, then asynchronously shuts down services, deletes `dorkHome`, and restarts
- `POST /api/admin/restart` — responds 200, then asynchronously shuts down services and restarts
- `triggerRestart()` helper with dev/prod branching (process.exit vs spawn-and-exit)
- Rate limiting via `express-rate-limit`: 3 requests per 5-minute window

Also:

- Add `express-rate-limit` dependency to `apps/server/package.json`
- Refactor `shutdown()` in `index.ts` to extract `shutdownServices()` (behavioral no-op)
- Mount admin router at `/api/admin` in `index.ts`
- Write 6 server test scenarios in `apps/server/src/routes/__tests__/admin.test.ts`

**Files**:

- `apps/server/src/routes/admin.ts` (NEW)
- `apps/server/src/index.ts` (MODIFY)
- `apps/server/src/routes/__tests__/admin.test.ts` (NEW)
- `apps/server/package.json` (MODIFY — add express-rate-limit)

---

## Phase 2: Transport & Client UI

### Task 2.1 — Add resetAllData and restartServer to Transport interface `[medium]`

**Dependencies**: 1.1

Add two new methods to the `Transport` interface in `packages/shared/src/transport.ts`:

- `resetAllData(confirm: string): Promise<{ message: string }>`
- `restartServer(): Promise<{ message: string }>`

Implement in:

- **HttpTransport**: POST to `/api/admin/reset` and `/api/admin/restart`
- **DirectTransport**: Both throw "not supported in Obsidian plugin mode"
- **Mock transport**: Add to `createMockTransport()` in test-utils

**Files**:

- `packages/shared/src/transport.ts` (MODIFY)
- HttpTransport file (MODIFY)
- DirectTransport file (MODIFY)
- `packages/test-utils/src/mock-factories.ts` (MODIFY)

---

### Task 2.2 — Create AdvancedTab with Danger Zone layout `[medium]`

**Dependencies**: 1.1 | **Parallel with**: 2.1, 2.3, 2.4

Danger Zone section with red border, TriangleAlert icon, and two action rows (Reset All Data, Restart Server). Each button opens its respective dialog.

**Files**:

- `apps/client/src/layers/features/settings/ui/AdvancedTab.tsx` (NEW)
- `apps/client/src/layers/features/settings/__tests__/AdvancedTab.test.tsx` (NEW)

---

### Task 2.3 — Create ResetDialog with type-to-confirm pattern `[medium]`

**Dependencies**: 2.1 | **Parallel with**: 2.2

AlertDialog requiring user to type "reset" to enable the submit button. On confirm: calls transport, clears localStorage, triggers restart overlay callback. Displays consequence list (Pulse, Relay, Mesh, config, logs).

**Files**:

- `apps/client/src/layers/features/settings/ui/ResetDialog.tsx` (NEW)
- `apps/client/src/layers/features/settings/__tests__/ResetDialog.test.tsx` (NEW)

---

### Task 2.4 — Create RestartDialog with confirmation `[small]`

**Dependencies**: 2.1 | **Parallel with**: 2.2, 2.3

Simple AlertDialog confirmation. On confirm: calls transport, triggers restart overlay callback.

**Files**:

- `apps/client/src/layers/features/settings/ui/RestartDialog.tsx` (NEW)
- `apps/client/src/layers/features/settings/__tests__/RestartDialog.test.tsx` (NEW)

---

## Phase 3: Reconnection & Integration

### Task 3.1 — Create ServerRestartOverlay with health polling `[medium]`

**Dependencies**: 2.1

Full-screen overlay via React portal. Polls `GET /api/health` every 1.5s. Auto-reloads on success. Shows error state with "Try Again" / "Dismiss" after 30-second timeout.

**Files**:

- `apps/client/src/layers/features/settings/ui/ServerRestartOverlay.tsx` (NEW)
- `apps/client/src/layers/features/settings/__tests__/ServerRestartOverlay.test.tsx` (NEW)

---

### Task 3.2 — Wire Advanced tab and overlay into SettingsDialog `[small]`

**Dependencies**: 2.2, 2.3, 2.4, 3.1

Modify `SettingsDialog.tsx` to:

- Add "Advanced" tab trigger (change `grid-cols-4` to `grid-cols-5`)
- Add `<AdvancedTab />` in new `TabsContent`
- Add `restartOverlayOpen` state and `<ServerRestartOverlay />`
- Both reset and restart callbacks open the overlay

**Files**:

- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` (MODIFY)

---

## Dependency Graph

```
1.1 (admin route)
 └─→ 2.1 (transport methods)
      ├─→ 2.3 (ResetDialog)  ──┐
      ├─→ 2.4 (RestartDialog) ─┤
      └─→ 3.1 (overlay)       ─┤
 └─→ 2.2 (AdvancedTab) ────────┤
                                └─→ 3.2 (wire into SettingsDialog)
```

## New Files Summary

| File                                                                               | Type            |
| ---------------------------------------------------------------------------------- | --------------- |
| `apps/server/src/routes/admin.ts`                                                  | Server route    |
| `apps/server/src/routes/__tests__/admin.test.ts`                                   | Server test     |
| `apps/client/src/layers/features/settings/ui/AdvancedTab.tsx`                      | React component |
| `apps/client/src/layers/features/settings/ui/ResetDialog.tsx`                      | React component |
| `apps/client/src/layers/features/settings/ui/RestartDialog.tsx`                    | React component |
| `apps/client/src/layers/features/settings/ui/ServerRestartOverlay.tsx`             | React component |
| `apps/client/src/layers/features/settings/__tests__/AdvancedTab.test.tsx`          | Client test     |
| `apps/client/src/layers/features/settings/__tests__/ResetDialog.test.tsx`          | Client test     |
| `apps/client/src/layers/features/settings/__tests__/RestartDialog.test.tsx`        | Client test     |
| `apps/client/src/layers/features/settings/__tests__/ServerRestartOverlay.test.tsx` | Client test     |

## Modified Files Summary

| File                                                             | Change                                           |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| `apps/server/src/index.ts`                                       | Extract `shutdownServices()`, mount admin router |
| `apps/server/package.json`                                       | Add `express-rate-limit` dependency              |
| `packages/shared/src/transport.ts`                               | Add `resetAllData` and `restartServer` methods   |
| HttpTransport implementation                                     | Add two method implementations                   |
| DirectTransport implementation                                   | Add two throwing stubs                           |
| `packages/test-utils/src/mock-factories.ts`                      | Add two mock methods                             |
| `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` | Add Advanced tab + overlay                       |
