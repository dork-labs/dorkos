# Permission Mode Management — Task Breakdown

**Spec:** `specs/permission-mode-management/02-specification.md`
**Generated:** 2026-04-10
**Mode:** Full decomposition

---

## Phase 1: Schema + Server (Foundation)

### Task 1.1 — Expand PermissionModeSchema to 6 values and update runtime capabilities

**Size:** Small | **Priority:** High | **Dependencies:** None

Expand the `PermissionModeSchema` Zod enum in `packages/shared/src/schemas.ts` from 4 values (`default`, `plan`, `acceptEdits`, `bypassPermissions`) to 6 by adding `dontAsk` and `auto`. Ordering follows ascending autonomy.

Update `supportedPermissionModes` in all 3 runtime capability sources:

- `apps/server/src/services/runtimes/claude-code/runtime-constants.ts` — `CLAUDE_CODE_CAPABILITIES`
- `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts` — `getCapabilities()`
- `packages/test-utils/src/fake-agent-runtime.ts` — `getCapabilities` mock

Update `packages/shared/src/__tests__/relay-binding-schemas.test.ts` to accept `auto` and `dontAsk` as valid permission modes (currently rejects `auto` at line 65).

---

### Task 1.2 — Remove message-sender allowlist and add passthrough tests

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

Replace the hardcoded 3-value allowlist in `apps/server/src/services/runtimes/claude-code/message-sender.ts` (lines 223-231) with a direct passthrough of `session.permissionMode` to `sdkOptions.permissionMode`. The `allowDangerouslySkipPermissions` flag stays for `bypassPermissions` only.

Add 4 tests verifying `dontAsk`, `auto`, `bypassPermissions`, and `default` all pass through correctly without transformation.

---

## Phase 2: Error Propagation

### Task 2.1 — Make updateSession async with setPermissionMode error propagation

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

Convert `updateSession()` across the stack:

- `packages/shared/src/agent-runtime.ts` — return type `boolean | Promise<boolean>`
- `apps/server/src/services/runtimes/claude-code/session-store.ts` — async, await `setPermissionMode()`, revert on failure, throw error
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — async wrapper

`TestModeRuntime` and `FakeAgentRuntime` require no changes (sync `boolean` satisfies union).

Add tests for revert-on-failure, success path, and no-activeQuery path.

---

### Task 2.2 — Update PATCH route handler to await updateSession and return 422 on rejection

**Size:** Small | **Priority:** High | **Dependencies:** 2.1

Update `apps/server/src/routes/sessions.ts` PATCH handler to `await runtime.updateSession()` inside a try/catch. On catch, return 422 with `{ error: 'Permission mode rejected by runtime', message: '<SDK error>' }`.

Add route-level tests for 422 rejection and 200 success.

---

## Phase 3: Client UI

### Task 3.1 — Add dontAsk and auto modes to PermissionModeItem with capability filtering

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 3.2

Expand `apps/client/src/layers/features/status/ui/PermissionModeItem.tsx`:

- Add `Lock` (dontAsk) and `Sparkles` (auto) icons from lucide-react
- Add 2 new entries to `PERMISSION_MODES` array with `warn` field
- Add `supportedModes?: PermissionMode[]` prop with filtering logic
- Use `warn` field for red styling instead of hardcoded `bypassPermissions` check

---

### Task 3.2 — Wire supportedModes from useDefaultCapabilities into ChatStatusSection

**Size:** Small | **Priority:** Medium | **Dependencies:** 3.1

In `apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx`:

- Import and call `useDefaultCapabilities()` from `@/layers/entities/runtime`
- Pass `capabilities?.supportedPermissionModes` to `PermissionModeItem` as `supportedModes`

---

### Task 3.3 — Add PermissionModeItem component tests

**Size:** Medium | **Priority:** Medium | **Dependencies:** 3.1 | **Parallel with:** 3.2

Create `apps/client/src/layers/features/status/__tests__/PermissionModeItem.test.tsx` with tests covering:

- All 6 modes render in dropdown
- `supportedModes` prop filters the dropdown
- Current mode displays in trigger even if not in `supportedModes`
- Mode selection callback fires correctly
- Disabled state shows tooltip
- `dontAsk` and `auto` render correctly in the trigger

---

### Task 3.4 — Add ChatStatusSection test for supportedModes wiring

**Size:** Small | **Priority:** Low | **Dependencies:** 3.2

Integration test verifying `ChatStatusSection` passes `supportedPermissionModes` from `useDefaultCapabilities()` to `PermissionModeItem`. Mock the capabilities hook and verify dropdown filtering.

---

## Summary

| Phase                      | Tasks              | Parallel Opportunities                                   |
| -------------------------- | ------------------ | -------------------------------------------------------- |
| Phase 1: Schema + Server   | 2 tasks (1.1, 1.2) | 1.2 depends on 1.1                                       |
| Phase 2: Error Propagation | 2 tasks (2.1, 2.2) | 2.1 depends on 1.1; 2.2 depends on 2.1                   |
| Phase 3: Client UI         | 4 tasks (3.1-3.4)  | 3.1 + 2.1 can run in parallel; 3.3 can parallel with 3.2 |

**Total:** 8 tasks (3 small, 4 medium, 1 small)
**Critical path:** 1.1 -> 1.2 -> verify; 1.1 -> 2.1 -> 2.2 -> verify; 3.1 -> 3.2 -> 3.4
